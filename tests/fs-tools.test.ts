import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WorkspaceSandbox } from '../packages/security/src/sandbox';
import {
  createFile,
  readFile,
  editFile,
  deleteFile,
  moveFile,
  searchFiles,
  listFiles,
} from '../packages/security/src/fs-tools';

describe('Filesystem Operations and Safe Edit Verification', () => {
  const testWorkspace = path.join(__dirname, 'temp_fs_workspace');
  let sandbox: WorkspaceSandbox;

  beforeEach(() => {
    if (fs.existsSync(testWorkspace)) {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
    fs.mkdirSync(testWorkspace, { recursive: true });
    sandbox = new WorkspaceSandbox(testWorkspace);
  });

  afterEach(() => {
    if (fs.existsSync(testWorkspace)) {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  it('creates a new file and automatically generates parent directories', async () => {
    const res = await createFile(sandbox, {
      path: 'nested/dir/app.ts',
      content: 'export const hello = "world";',
    });
    assert.strictEqual(res.created, true);
    assert.strictEqual(res.path, 'nested/dir/app.ts');
    assert.ok(fs.existsSync(path.join(testWorkspace, 'nested/dir/app.ts')));
  });

  it('refuses to overwrite existing file without overwrite: true', async () => {
    await createFile(sandbox, { path: 'test.txt', content: 'v1' });
    await assert.rejects(async () => {
      await createFile(sandbox, { path: 'test.txt', content: 'v2', overwrite: false });
    }, /already exists/);
  });

  it('reads created file contents and calculates line counts', async () => {
    await createFile(sandbox, { path: 'lines.txt', content: 'line1\nline2\nline3' });
    const res = await readFile(sandbox, { path: 'lines.txt' });
    assert.strictEqual(res.lines, 3);
    assert.strictEqual(res.content, 'line1\nline2\nline3');
  });

  it('performs safe exact-match text replacement with edit_file', async () => {
    await createFile(sandbox, { path: 'code.ts', content: 'const greeting = "Hello World";' });
    const res = await editFile(sandbox, {
      path: 'code.ts',
      old_text: 'Hello World',
      new_text: 'Hello Gemini Spark',
    });
    assert.strictEqual(res.replacements, 1);
    const read = await readFile(sandbox, { path: 'code.ts' });
    assert.strictEqual(read.content, 'const greeting = "Hello Gemini Spark";');
  });

  it('fails safely when old_text does not match in edit_file', async () => {
    await createFile(sandbox, { path: 'code.ts', content: 'const greeting = "Hello World";' });
    await assert.rejects(async () => {
      await editFile(sandbox, {
        path: 'code.ts',
        old_text: 'Target Text That Does Not Exist',
        new_text: 'Replacement',
      });
    }, /old_text was not found/);

    // Verify file remains unmodified
    const read = await readFile(sandbox, { path: 'code.ts' });
    assert.strictEqual(read.content, 'const greeting = "Hello World";');
  });

  it('searches for queries across files and returns line numbers', async () => {
    await createFile(sandbox, { path: 'fileA.txt', content: 'Apple\nBanana\nOrange' });
    await createFile(sandbox, { path: 'fileB.txt', content: 'Red\nBanana split\nYellow' });

    const res = await searchFiles(sandbox, { query: 'Banana' });
    assert.strictEqual(res.totalMatches, 2);
    assert.strictEqual(res.matches[0].file, 'fileA.txt');
    assert.strictEqual(res.matches[0].lineNumber, 2);
    assert.strictEqual(res.matches[1].file, 'fileB.txt');
    assert.strictEqual(res.matches[1].lineNumber, 2);
  });

  it('moves files within the workspace safely', async () => {
    await createFile(sandbox, { path: 'old.txt', content: 'content' });
    const res = await moveFile(sandbox, { source_path: 'old.txt', destination_path: 'new.txt' });
    assert.strictEqual(res.success, true);
    assert.ok(!fs.existsSync(path.join(testWorkspace, 'old.txt')));
    assert.ok(fs.existsSync(path.join(testWorkspace, 'new.txt')));
  });

  it('deletes files safely', async () => {
    await createFile(sandbox, { path: 'to_delete.txt', content: 'bye' });
    const res = await deleteFile(sandbox, { path: 'to_delete.txt' });
    assert.strictEqual(res.deleted, true);
    assert.ok(!fs.existsSync(path.join(testWorkspace, 'to_delete.txt')));
  });
});
