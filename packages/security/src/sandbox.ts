/**
 * VibeBridge Workspace Sandbox
 * Ensures all filesystem and terminal operations are strictly confined to the selected workspace.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export class SecurityError extends Error {
  constructor(message: string, public readonly code: string = 'SECURITY_VIOLATION') {
    super(message);
    this.name = 'SecurityError';
  }
}

export class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FileNotFoundError';
  }
}

export class WorkspaceSandbox {
  private readonly canonicalWorkspace: string;

  constructor(workspacePath: string) {
    if (!workspacePath || typeof workspacePath !== 'string') {
      throw new SecurityError('Invalid workspace path provided', 'INVALID_WORKSPACE');
    }

    const resolved = path.resolve(workspacePath);
    if (!fs.existsSync(resolved)) {
      throw new SecurityError(`Workspace path does not exist: ${resolved}`, 'WORKSPACE_NOT_FOUND');
    }

    const stats = fs.statSync(resolved);
    if (!stats.isDirectory()) {
      throw new SecurityError(`Workspace path is not a directory: ${resolved}`, 'WORKSPACE_NOT_DIR');
    }

    // Resolve canonical real path (resolves symlinks)
    this.canonicalWorkspace = fs.realpathSync(resolved);
  }

  /**
   * Returns the canonical, fully resolved path to the workspace root.
   */
  public getCanonicalPath(): string {
    return this.canonicalWorkspace;
  }

  /**
   * Validates and resolves a user-provided path within the workspace.
   * Defends against:
   * - null byte injections
   * - path traversal (../, ..\, etc.)
   * - absolute paths pointing outside workspace
   * - symlink escapes
   * - Windows drive letter / UNC jumps
   */
  public resolveSafePath(userPath: string, options: { mustExist?: boolean } = {}): string {
    if (userPath === null || userPath === undefined || typeof userPath !== 'string') {
      throw new SecurityError('Path must be a non-empty string', 'INVALID_PATH');
    }

    // Check for null bytes
    if (userPath.includes('\0')) {
      throw new SecurityError('Path contains null bytes', 'NULL_BYTE_DETECTED');
    }

    // Normalize and resolve against canonical workspace
    const rawResolved = path.resolve(this.canonicalWorkspace, userPath);

    // Initial boundary check on normalized path string
    if (!this.isInsideWorkspace(rawResolved)) {
      throw new SecurityError(
        `Path traversal attempt detected: '${userPath}' resolves outside workspace boundary`,
        'PATH_TRAVERSAL_DETECTED'
      );
    }

    // If target exists, verify realpath (resolves symlinks)
    if (fs.existsSync(rawResolved)) {
      const realTarget = fs.realpathSync(rawResolved);
      if (!this.isInsideWorkspace(realTarget)) {
        throw new SecurityError(
          `Symlink traversal attempt detected: '${userPath}' points outside workspace boundary to '${realTarget}'`,
          'SYMLINK_ESCAPE_DETECTED'
        );
      }
      return realTarget;
    }

    // If it does not exist and caller requires existence
    if (options.mustExist) {
      throw new FileNotFoundError(`File or directory does not exist: ${userPath}`);
    }

    // If creating a new file/folder, check the closest existing ancestor directory
    let currentDir = path.dirname(rawResolved);
    while (currentDir.length >= this.canonicalWorkspace.length) {
      if (fs.existsSync(currentDir)) {
        const realDir = fs.realpathSync(currentDir);
        if (!this.isInsideWorkspace(realDir)) {
          throw new SecurityError(
            `Ancestor symlink traversal detected for '${userPath}'`,
            'ANCESTOR_SYMLINK_ESCAPE'
          );
        }
        break;
      }
      const parent = path.dirname(currentDir);
      if (parent === currentDir) break;
      currentDir = parent;
    }

    return rawResolved;
  }

  /**
   * Checks if an absolute path is strictly within the canonical workspace directory.
   */
  public isInsideWorkspace(targetPath: string): boolean {
    if (targetPath === this.canonicalWorkspace) {
      return true;
    }
    const relative = path.relative(this.canonicalWorkspace, targetPath);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  /**
   * Converts an absolute path to a workspace-relative path.
   */
  public toRelativePath(absolutePath: string): string {
    const rel = path.relative(this.canonicalWorkspace, absolutePath);
    return rel === '' ? '.' : rel.split(path.sep).join('/');
  }
}
