import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WorkspaceSandbox, SecurityError, FileNotFoundError } from '../packages/security/src/sandbox';

describe('Workspace Sandbox & Path Traversal Prevention', () => {
  const testWorkspace = path.join(__dirname, 'temp_security_workspace');

  beforeEach(() => {
    if (fs.existsSync(testWorkspace)) {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
    fs.mkdirSync(testWorkspace, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(testWorkspace)) {
      fs.rmSync(testWorkspace, { recursive: true, force: true });
    }
  });

  it('verifies canonical workspace path', () => {
    const sandbox = new WorkspaceSandbox(testWorkspace);
    assert.strictEqual(sandbox.getCanonicalPath(), fs.realpathSync(testWorkspace));
  });

  it('rejects path traversal attempting to escape via ../', () => {
    const sandbox = new WorkspaceSandbox(testWorkspace);
    assert.throws(
      () => sandbox.resolveSafePath('../../etc/shadow'),
      (err: any) => err instanceof SecurityError && err.code === 'PATH_TRAVERSAL_DETECTED'
    );
  });

  it('rejects nested path traversal tricks (foo/bar/../../../../etc)', () => {
    const sandbox = new WorkspaceSandbox(testWorkspace);
    assert.throws(
      () => sandbox.resolveSafePath('sub/dir/../../../../etc/passwd'),
      (err: any) => err instanceof SecurityError && err.code === 'PATH_TRAVERSAL_DETECTED'
    );
  });

  it('rejects null byte injection', () => {
    const sandbox = new WorkspaceSandbox(testWorkspace);
    assert.throws(
      () => sandbox.resolveSafePath('exploit\0.txt'),
      (err: any) => err instanceof SecurityError && err.code === 'NULL_BYTE_DETECTED'
    );
  });

  it('rejects absolute paths outside the workspace boundary', () => {
    const sandbox = new WorkspaceSandbox(testWorkspace);
    assert.throws(
      () => sandbox.resolveSafePath('/System/Library/CoreServices'),
      (err: any) => err instanceof SecurityError && err.code === 'PATH_TRAVERSAL_DETECTED'
    );
  });

  it('allows valid subpaths inside the workspace', () => {
    const sandbox = new WorkspaceSandbox(testWorkspace);
    const resolved = sandbox.resolveSafePath('src/index.ts');
    assert.ok(sandbox.isInsideWorkspace(resolved));
    assert.strictEqual(sandbox.toRelativePath(resolved), 'src/index.ts');
  });
});
