const test = require('node:test');
const assert = require('node:assert');

class PermissionManager {
  constructor(mode = 'prompt') {
    this.mode = mode;
    this.pending = new Map();
  }
  static getToolCategory(toolName) {
    if (['list_files', 'read_file', 'search_files'].includes(toolName)) return 'read';
    if (['create_file', 'edit_file', 'delete_file', 'move_file'].includes(toolName)) return 'write';
    if (toolName === 'run_command') return 'execute';
    return 'write';
  }
  async authorize(operation, target) {
    const category = PermissionManager.getToolCategory(operation);
    if (this.mode === 'auto_approve_all') return true;
    if (this.mode === 'deny_writes') {
      if (category === 'write' || category === 'execute') {
        throw new Error('Permission denied: strict read-only mode');
      }
      return true;
    }
    if (category === 'read') return true;
    return new Promise((resolve, reject) => {
      this.pending.set(target, { resolve, reject });
    });
  }
  respond(target, allowed) {
    const resolver = this.pending.get(target);
    if (!resolver) return false;
    this.pending.delete(target);
    if (allowed) resolver.resolve(true);
    else resolver.reject(new Error('User denied operation'));
    return true;
  }
}

test('Permission Manager Workflow', async (t) => {
  await t.test('auto approves read in prompt mode', async () => {
    const pm = new PermissionManager('prompt');
    const allowed = await pm.authorize('read_file', 'src/main.ts');
    assert.strictEqual(allowed, true);
  });

  await t.test('denies write in deny_writes mode', async () => {
    const pm = new PermissionManager('deny_writes');
    await assert.rejects(async () => {
      await pm.authorize('create_file', 'src/new.ts');
    }, /Permission denied: strict read-only mode/);
  });

  await t.test('prompts and allows write when user permits', async () => {
    const pm = new PermissionManager('prompt');
    const authPromise = pm.authorize('create_file', 'src/new.ts');
    pm.respond('src/new.ts', true);
    const result = await authPromise;
    assert.strictEqual(result, true);
  });

  await t.test('prompts and rejects write when user denies', async () => {
    const pm = new PermissionManager('prompt');
    const authPromise = pm.authorize('delete_file', 'src/important.ts');
    pm.respond('src/important.ts', false);
    await assert.rejects(async () => {
      await authPromise;
    }, /User denied operation/);
  });
});
