/**
 * VibeBridge Filesystem Tools
 * Implements safe, sandboxed file operations.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { WorkspaceSandbox, SecurityError, FileNotFoundError } from './sandbox';
import {
  ListFilesInput,
  ListFilesResult,
  FileEntry,
  ReadFileInput,
  ReadFileResult,
  SearchFilesInput,
  SearchFilesResult,
  SearchMatch,
  CreateFileInput,
  CreateFileResult,
  EditFileInput,
  EditFileResult,
  DeleteFileInput,
  DeleteFileResult,
  MoveFileInput,
  MoveFileResult,
} from '@vibebridge/shared';

export class FileOperationError extends Error {
  constructor(message: string, public readonly code: string = 'FILE_OP_ERROR') {
    super(message);
    this.name = 'FileOperationError';
  }
}

/**
 * List files and directories within the workspace.
 */
export async function listFiles(
  sandbox: WorkspaceSandbox,
  input: ListFilesInput
): Promise<ListFilesResult> {
  const targetPath = sandbox.resolveSafePath(input.path || '', { mustExist: true });
  const stats = await fs.promises.stat(targetPath);

  if (!stats.isDirectory()) {
    throw new FileOperationError(`Path is not a directory: ${input.path || '.'}`, 'NOT_A_DIRECTORY');
  }

  const recursive = input.recursive ?? false;
  const includeHidden = input.include_hidden ?? false;
  const maxDepth = input.max_depth ?? 10;
  const maxFiles = input.max_files ?? 1000;

  const entries: FileEntry[] = [];
  let truncated = false;

  async function walk(currentDir: string, currentDepth: number) {
    if (entries.length >= maxFiles) {
      truncated = true;
      return;
    }
    if (currentDepth > maxDepth) {
      return;
    }

    const items = await fs.promises.readdir(currentDir, { withFileTypes: true });

    for (const item of items) {
      if (entries.length >= maxFiles) {
        truncated = true;
        break;
      }

      if (!includeHidden && item.name.startsWith('.')) {
        continue;
      }

      // Skip common heavy directories in recursive listings unless explicitly requested
      if (recursive && (item.name === 'node_modules' || item.name === '.git')) {
        continue;
      }

      const itemFullPath = path.join(currentDir, item.name);
      try {
        const itemStats = await fs.promises.stat(itemFullPath);
        const relPath = sandbox.toRelativePath(itemFullPath);

        entries.push({
          name: item.name,
          path: relPath,
          isDirectory: item.isDirectory(),
          size: itemStats.size,
          modifiedTime: itemStats.mtime.toISOString(),
        });

        if (recursive && item.isDirectory()) {
          await walk(itemFullPath, currentDepth + 1);
        }
      } catch {
        // Skip files that might be broken symlinks or inaccessible
      }
    }
  }

  await walk(targetPath, 1);

  return {
    path: sandbox.toRelativePath(targetPath),
    files: entries,
    totalFiles: entries.length,
    truncated,
  };
}

/**
 * Reads a file's content with safety checks and optional line pagination.
 */
export async function readFile(
  sandbox: WorkspaceSandbox,
  input: ReadFileInput
): Promise<ReadFileResult> {
  const safePath = sandbox.resolveSafePath(input.path, { mustExist: true });
  const stats = await fs.promises.stat(safePath);

  if (stats.isDirectory()) {
    throw new FileOperationError(`Cannot read '${input.path}': path is a directory, not a file`, 'IS_A_DIRECTORY');
  }

  const maxReadBytes = 10 * 1024 * 1024; // 10MB safety cap
  if (stats.size > maxReadBytes) {
    throw new FileOperationError(
      `File size (${(stats.size / 1024 / 1024).toFixed(2)} MB) exceeds maximum allowed read limit (10 MB). Use line offsets to read smaller chunks.`,
      'FILE_TOO_LARGE'
    );
  }

  const rawBuffer = await fs.promises.readFile(safePath);

  // Simple binary detection (presence of null byte in first 8KB)
  const checkSample = rawBuffer.subarray(0, Math.min(8192, rawBuffer.length));
  if (checkSample.includes(0)) {
    throw new FileOperationError(`File '${input.path}' appears to be binary and cannot be read as text`, 'BINARY_FILE');
  }

  const fullContent = rawBuffer.toString((input.encoding as BufferEncoding) || 'utf-8');
  const lines = fullContent.split('\n');

  if (input.line_offset !== undefined || input.line_count !== undefined) {
    const offset = Math.max(0, input.line_offset ?? 0);
    const count = input.line_count ?? lines.length;
    const sliced = lines.slice(offset, offset + count);
    const isTruncated = offset + count < lines.length;

    return {
      path: sandbox.toRelativePath(safePath),
      content: sliced.join('\n'),
      lines: sliced.length,
      sizeBytes: Buffer.byteLength(sliced.join('\n')),
      isTruncated,
    };
  }

  return {
    path: sandbox.toRelativePath(safePath),
    content: fullContent,
    lines: lines.length,
    sizeBytes: stats.size,
  };
}

/**
 * Searches files for specific text or regex across workspace files.
 */
export async function searchFiles(
  sandbox: WorkspaceSandbox,
  input: SearchFilesInput
): Promise<SearchFilesResult> {
  const startDir = sandbox.resolveSafePath(input.path || '', { mustExist: true });
  const stats = await fs.promises.stat(startDir);

  if (!stats.isDirectory()) {
    throw new FileOperationError(`Search path is not a directory: ${input.path || '.'}`, 'NOT_A_DIRECTORY');
  }

  const maxResults = input.max_results ?? 100;
  const caseSensitive = input.case_sensitive ?? false;
  const matches: SearchMatch[] = [];
  let truncated = false;

  const searchQuery = caseSensitive ? input.query : input.query.toLowerCase();

  // Simple glob/pattern matcher (e.g. *.ts, .json)
  const patternRegex = input.file_pattern
    ? new RegExp('^' + input.file_pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$')
    : null;

  async function searchDir(dir: string, depth: number) {
    if (matches.length >= maxResults) {
      truncated = true;
      return;
    }
    if (depth > 15) return;

    const items = await fs.promises.readdir(dir, { withFileTypes: true });

    for (const item of items) {
      if (matches.length >= maxResults) {
        truncated = true;
        break;
      }

      // Ignore common non-source directories
      if (item.name === 'node_modules' || item.name === '.git' || item.name === 'dist' || item.name === 'build') {
        continue;
      }

      const fullPath = path.join(dir, item.name);

      if (item.isDirectory()) {
        await searchDir(fullPath, depth + 1);
      } else if (item.isFile()) {
        if (patternRegex && !patternRegex.test(item.name)) {
          continue;
        }

        try {
          const fileStat = await fs.promises.stat(fullPath);
          if (fileStat.size > 2 * 1024 * 1024) continue; // Skip files > 2MB

          const buffer = await fs.promises.readFile(fullPath);
          if (buffer.subarray(0, 4096).includes(0)) continue; // Skip binary

          const content = buffer.toString('utf-8');
          const lines = content.split('\n');

          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= maxResults) {
              truncated = true;
              break;
            }

            const line = lines[i];
            const targetLine = caseSensitive ? line : line.toLowerCase();

            if (targetLine.includes(searchQuery)) {
              matches.push({
                file: sandbox.toRelativePath(fullPath),
                lineNumber: i + 1,
                lineContent: line.trim(),
              });
            }
          }
        } catch {
          // Ignore read errors for inaccessible files
        }
      }
    }
  }

  await searchDir(startDir, 1);

  return {
    query: input.query,
    matches,
    totalMatches: matches.length,
    truncated,
  };
}

/**
 * Creates a new file safely in the workspace.
 */
export async function createFile(
  sandbox: WorkspaceSandbox,
  input: CreateFileInput
): Promise<CreateFileResult> {
  const safePath = sandbox.resolveSafePath(input.path, { mustExist: false });

  if (fs.existsSync(safePath)) {
    if (!input.overwrite) {
      throw new FileOperationError(
        `File '${input.path}' already exists. Set overwrite: true to replace it.`,
        'FILE_ALREADY_EXISTS'
      );
    }
  }

  // Ensure parent directory exists
  const parentDir = path.dirname(safePath);
  if (!fs.existsSync(parentDir)) {
    await fs.promises.mkdir(parentDir, { recursive: true });
  }

  await fs.promises.writeFile(safePath, input.content, 'utf-8');
  const stats = await fs.promises.stat(safePath);

  return {
    path: sandbox.toRelativePath(safePath),
    bytesWritten: stats.size,
    created: true,
  };
}

/**
 * Safely edits a file by verifying exact presence of old_text before replacement.
 * Fails safely with structured error if old_text is missing.
 */
export async function editFile(
  sandbox: WorkspaceSandbox,
  input: EditFileInput
): Promise<EditFileResult> {
  const safePath = sandbox.resolveSafePath(input.path, { mustExist: true });
  const stats = await fs.promises.stat(safePath);

  if (stats.isDirectory()) {
    throw new FileOperationError(`Cannot edit '${input.path}': path is a directory`, 'IS_A_DIRECTORY');
  }

  const content = await fs.promises.readFile(safePath, 'utf-8');

  // Exact match verification
  if (!content.includes(input.old_text)) {
    // Generate context snippet to assist user or model
    const preview = content.length > 500 ? content.slice(0, 500) + '...' : content;
    throw new FileOperationError(
      `Failed to edit file '${input.path}': The specified old_text was not found in the file.\n` +
      `Expected snippet:\n"""\n${input.old_text}\n"""\n` +
      `Current file preview (${content.split('\n').length} total lines):\n"""\n${preview}\n"""`,
      'OLD_TEXT_NOT_FOUND'
    );
  }

  let newContent: string;
  let replacements = 0;

  if (input.replace_all) {
    const parts = content.split(input.old_text);
    replacements = parts.length - 1;
    newContent = parts.join(input.new_text);
  } else {
    replacements = 1;
    newContent = content.replace(input.old_text, input.new_text);
  }

  await fs.promises.writeFile(safePath, newContent, 'utf-8');
  const newStats = await fs.promises.stat(safePath);

  return {
    path: sandbox.toRelativePath(safePath),
    replacements,
    newSizeBytes: newStats.size,
  };
}

/**
 * Safely deletes a file or directory inside the workspace.
 */
export async function deleteFile(
  sandbox: WorkspaceSandbox,
  input: DeleteFileInput
): Promise<DeleteFileResult> {
  const safePath = sandbox.resolveSafePath(input.path, { mustExist: true });

  // Prevent deleting the workspace root itself!
  if (safePath === sandbox.getCanonicalPath()) {
    throw new SecurityError('Cannot delete the root workspace directory', 'WORKSPACE_ROOT_DELETE_FORBIDDEN');
  }

  const stats = await fs.promises.stat(safePath);
  const isDirectory = stats.isDirectory();

  if (isDirectory) {
    if (!input.recursive) {
      throw new FileOperationError(
        `'${input.path}' is a directory. Set recursive: true to delete it.`,
        'DIRECTORY_NOT_EMPTY'
      );
    }
    await fs.promises.rm(safePath, { recursive: true, force: true });
  } else {
    await fs.promises.unlink(safePath);
  }

  return {
    path: sandbox.toRelativePath(safePath),
    deleted: true,
    isDirectory,
  };
}

/**
 * Safely renames or moves a file or directory within the workspace.
 */
export async function moveFile(
  sandbox: WorkspaceSandbox,
  input: MoveFileInput
): Promise<MoveFileResult> {
  const sourceSafe = sandbox.resolveSafePath(input.source_path, { mustExist: true });
  const destSafe = sandbox.resolveSafePath(input.destination_path, { mustExist: false });

  if (sourceSafe === sandbox.getCanonicalPath()) {
    throw new SecurityError('Cannot move the root workspace directory', 'WORKSPACE_ROOT_MOVE_FORBIDDEN');
  }

  if (fs.existsSync(destSafe) && !input.overwrite) {
    throw new FileOperationError(
      `Destination '${input.destination_path}' already exists. Set overwrite: true to replace.`,
      'DESTINATION_EXISTS'
    );
  }

  const destParent = path.dirname(destSafe);
  if (!fs.existsSync(destParent)) {
    await fs.promises.mkdir(destParent, { recursive: true });
  }

  await fs.promises.rename(sourceSafe, destSafe);

  return {
    source_path: sandbox.toRelativePath(sourceSafe),
    destination_path: sandbox.toRelativePath(destSafe),
    success: true,
  };
}
