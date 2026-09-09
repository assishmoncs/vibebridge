import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WorkspaceSandbox } from '../packages/security/src/sandbox';
import { runCommand } from '../packages/security/src/terminal';

describe('Terminal Execution Engine', () => {
  const testWorkspace = path.join(__dirname, 'temp_term_workspace');
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

  it('executes command inside workspace directory as cwd', async () => {
    const res = await runCommand(sandbox, { command: 'pwd' });
    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.stdout.trim(), sandbox.getCanonicalPath());
    assert.strictEqual(res.workingDirectory, sandbox.getCanonicalPath());
    assert.ok(res.durationMs >= 0);
  });

  it('captures exit code and stderr on failure', async () => {
    const res = await runCommand(sandbox, { command: 'sh -c "exit 42"' });
    assert.strictEqual(res.exitCode, 42);
  });

  it('kills hanging command when timeout is exceeded', async () => {
    const res = await runCommand(sandbox, { command: 'sleep 5', timeout_ms: 1000 });
    assert.strictEqual(res.killed, true);
    assert.ok(res.stderr.includes('timed out'));
  });
});
