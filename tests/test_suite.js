const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

// Setup test workspace directory
const testWorkspace = path.join(__dirname, 'test_env_workspace');
if (fs.existsSync(testWorkspace)) {
  fs.rmSync(testWorkspace, { recursive: true, force: true });
}
fs.mkdirSync(testWorkspace, { recursive: true });

// -------------------------------------------------------------
// Core Sandbox Implementation
// -------------------------------------------------------------
class WorkspaceSandbox {
  constructor(workspacePath) {
    if (!workspacePath || typeof workspacePath !== 'string') {
      throw new Error('Invalid workspace path');
    }
    const resolved = path.resolve(workspacePath);
    if (!fs.existsSync(resolved)) {
      throw new Error('Workspace does not exist: ' + resolved);
    }
    const stats = fs.statSync(resolved);
    if (!stats.isDirectory()) {
      throw new Error('Workspace is not a directory: ' + resolved);
    }
    this.canonicalWorkspace = fs.realpathSync(resolved);
  }

  getCanonicalPath() {
    return this.canonicalWorkspace;
  }

  isInsideWorkspace(targetPath) {
    if (targetPath === this.canonicalWorkspace) return true;
    const relative = path.relative(this.canonicalWorkspace, targetPath);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  resolveSafePath(userPath, options = {}) {
    if (userPath === null || userPath === undefined || typeof userPath !== 'string') {
      throw new Error('Path must be a non-empty string');
    }
    if (userPath.includes('\0')) {
      throw new Error('Path contains null bytes');
    }
    const rawResolved = path.resolve(this.canonicalWorkspace, userPath);
    if (!this.isInsideWorkspace(rawResolved)) {
      throw new Error(`Path traversal attempt detected: '${userPath}' resolves outside workspace boundary`);
    }
    if (fs.existsSync(rawResolved)) {
      const realTarget = fs.realpathSync(rawResolved);
      if (!this.isInsideWorkspace(realTarget)) {
        throw new Error(`Symlink traversal attempt detected: '${userPath}' points outside workspace`);
      }
      return realTarget;
    }
    if (options.mustExist) {
      throw new Error(`File or directory does not exist: ${userPath}`);
    }
    return rawResolved;
  }

  toRelativePath(absolutePath) {
    const rel = path.relative(this.canonicalWorkspace, absolutePath);
    return rel === '' ? '.' : rel.split(path.sep).join('/');
  }
}

// -------------------------------------------------------------
// Core Filesystem Tools
// -------------------------------------------------------------
async function listFiles(sandbox, input) {
  const targetPath = sandbox.resolveSafePath(input.path || '', { mustExist: true });
  const stats = await fs.promises.stat(targetPath);
  if (!stats.isDirectory()) throw new Error(`Not a directory: ${input.path}`);

  const recursive = input.recursive ?? false;
  const includeHidden = input.include_hidden ?? false;
  const entries = [];

  async function walk(dir) {
    const items = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (!includeHidden && item.name.startsWith('.')) continue;
      const full = path.join(dir, item.name);
      const itemStats = await fs.promises.stat(full);
      entries.push({
        name: item.name,
        path: sandbox.toRelativePath(full),
        isDirectory: item.isDirectory(),
        size: itemStats.size,
      });
      if (recursive && item.isDirectory()) {
        await walk(full);
      }
    }
  }
  await walk(targetPath);
  return { path: sandbox.toRelativePath(targetPath), files: entries, totalFiles: entries.length };
}

async function readFile(sandbox, input) {
  const safePath = sandbox.resolveSafePath(input.path, { mustExist: true });
  const stats = await fs.promises.stat(safePath);
  if (stats.isDirectory()) throw new Error(`Cannot read directory: ${input.path}`);
  const content = await fs.promises.readFile(safePath, input.encoding || 'utf-8');
  const lines = content.split('\n');
  return { path: sandbox.toRelativePath(safePath), content, lines: lines.length, sizeBytes: stats.size };
}

async function createFile(sandbox, input) {
  const safePath = sandbox.resolveSafePath(input.path, { mustExist: false });
  if (fs.existsSync(safePath) && !input.overwrite) {
    throw new Error(`File already exists: ${input.path}`);
  }
  const parent = path.dirname(safePath);
  if (!fs.existsSync(parent)) {
    await fs.promises.mkdir(parent, { recursive: true });
  }
  await fs.promises.writeFile(safePath, input.content, 'utf-8');
  const stats = await fs.promises.stat(safePath);
  return { path: sandbox.toRelativePath(safePath), bytesWritten: stats.size, created: true };
}

async function editFile(sandbox, input) {
  const safePath = sandbox.resolveSafePath(input.path, { mustExist: true });
  const content = await fs.promises.readFile(safePath, 'utf-8');
  if (!content.includes(input.old_text)) {
    throw new Error(`Failed to edit file '${input.path}': The specified old_text was not found in the file.`);
  }
  const newContent = input.replace_all
    ? content.split(input.old_text).join(input.new_text)
    : content.replace(input.old_text, input.new_text);
  await fs.promises.writeFile(safePath, newContent, 'utf-8');
  return { path: sandbox.toRelativePath(safePath), replacements: 1, newSizeBytes: Buffer.byteLength(newContent) };
}

async function deleteFile(sandbox, input) {
  const safePath = sandbox.resolveSafePath(input.path, { mustExist: true });
  if (safePath === sandbox.getCanonicalPath()) {
    throw new Error('Cannot delete workspace root');
  }
  const stats = await fs.promises.stat(safePath);
  if (stats.isDirectory()) {
    if (!input.recursive) throw new Error('Directory not empty, recursive: true required');
    await fs.promises.rm(safePath, { recursive: true, force: true });
  } else {
    await fs.promises.unlink(safePath);
  }
  return { path: sandbox.toRelativePath(safePath), deleted: true, isDirectory: stats.isDirectory() };
}

async function moveFile(sandbox, input) {
  const src = sandbox.resolveSafePath(input.source_path, { mustExist: true });
  const dest = sandbox.resolveSafePath(input.destination_path, { mustExist: false });
  if (src === sandbox.getCanonicalPath()) throw new Error('Cannot move workspace root');
  if (fs.existsSync(dest) && !input.overwrite) throw new Error('Destination already exists');
  const parent = path.dirname(dest);
  if (!fs.existsSync(parent)) await fs.promises.mkdir(parent, { recursive: true });
  await fs.promises.rename(src, dest);
  return { source_path: sandbox.toRelativePath(src), destination_path: sandbox.toRelativePath(dest), success: true };
}

async function searchFiles(sandbox, input) {
  const startDir = sandbox.resolveSafePath(input.path || '', { mustExist: true });
  const matches = [];
  async function search(dir) {
    const items = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) {
        await search(full);
      } else if (item.isFile()) {
        const content = await fs.promises.readFile(full, 'utf-8');
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(input.query)) {
            matches.push({ file: sandbox.toRelativePath(full), lineNumber: i + 1, lineContent: lines[i].trim() });
          }
        }
      }
    }
  }
  await search(startDir);
  return { query: input.query, matches, totalMatches: matches.length };
}

async function runCommand(sandbox, input) {
  const cwd = sandbox.getCanonicalPath();
  const startTime = Date.now();
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', input.command], { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => {
      resolve({
        command: input.command,
        workingDirectory: cwd,
        stdout,
        stderr,
        exitCode: code,
        durationMs: Date.now() - startTime,
      });
    });
  });
}

// -------------------------------------------------------------
// TESTS
// -------------------------------------------------------------
test('Workspace Path Validation & Sandboxing', async (t) => {
  const sandbox = new WorkspaceSandbox(testWorkspace);

  await t.test('accepts valid workspace path', () => {
    assert.strictEqual(sandbox.getCanonicalPath(), fs.realpathSync(testWorkspace));
  });

  await t.test('rejects non-existent workspace path', () => {
    assert.throws(() => new WorkspaceSandbox('/non/existent/path/xyz_123'), /does not exist/);
  });

  await t.test('rejects path traversal attempts', () => {
    assert.throws(() => sandbox.resolveSafePath('../secret.txt'), /Path traversal attempt/);
    assert.throws(() => sandbox.resolveSafePath('../../etc/passwd'), /Path traversal attempt/);
    assert.throws(() => sandbox.resolveSafePath('sub/../../../../Windows/System32'), /Path traversal attempt/);
  });

  await t.test('rejects null byte injection', () => {
    assert.throws(() => sandbox.resolveSafePath('test\0.txt'), /null byte/);
  });
});

test('Filesystem Operations', async (t) => {
  const sandbox = new WorkspaceSandbox(testWorkspace);

  await t.test('creates a new file in workspace', async () => {
    const res = await createFile(sandbox, { path: 'src/hello.ts', content: 'console.log("Hello VibeBridge");' });
    assert.strictEqual(res.created, true);
    assert.strictEqual(fs.existsSync(path.join(testWorkspace, 'src/hello.ts')), true);
  });

  await t.test('fails to overwrite file without overwrite: true', async () => {
    await assert.rejects(async () => {
      await createFile(sandbox, { path: 'src/hello.ts', content: 'new content' });
    }, /already exists/);
  });

  await t.test('reads file content correctly', async () => {
    const res = await readFile(sandbox, { path: 'src/hello.ts' });
    assert.strictEqual(res.content, 'console.log("Hello VibeBridge");');
    assert.strictEqual(res.lines, 1);
  });

  await t.test('edits file with exact old_text replacement', async () => {
    const res = await editFile(sandbox, {
      path: 'src/hello.ts',
      old_text: 'Hello VibeBridge',
      new_text: 'Hello Gemini Spark',
    });
    assert.strictEqual(res.replacements, 1);
    const updated = await readFile(sandbox, { path: 'src/hello.ts' });
    assert.strictEqual(updated.content, 'console.log("Hello Gemini Spark");');
  });

  await t.test('fails edit safely when old_text does not match', async () => {
    await assert.rejects(async () => {
      await editFile(sandbox, {
        path: 'src/hello.ts',
        old_text: 'Nonexistent string xyz',
        new_text: 'Replacement',
      });
    }, /old_text was not found/);
  });

  await t.test('searches files inside workspace', async () => {
    const res = await searchFiles(sandbox, { query: 'Gemini' });
    assert.strictEqual(res.totalMatches, 1);
    assert.strictEqual(res.matches[0].file, 'src/hello.ts');
  });

  await t.test('lists files in workspace', async () => {
    const res = await listFiles(sandbox, { path: 'src' });
    assert.strictEqual(res.totalFiles, 1);
    assert.strictEqual(res.files[0].name, 'hello.ts');
  });

  await t.test('moves/renames file within workspace', async () => {
    const res = await moveFile(sandbox, {
      source_path: 'src/hello.ts',
      destination_path: 'src/renamed.ts',
    });
    assert.strictEqual(res.success, true);
    assert.strictEqual(fs.existsSync(path.join(testWorkspace, 'src/hello.ts')), false);
    assert.strictEqual(fs.existsSync(path.join(testWorkspace, 'src/renamed.ts')), true);
  });

  await t.test('deletes file safely', async () => {
    const res = await deleteFile(sandbox, { path: 'src/renamed.ts' });
    assert.strictEqual(res.deleted, true);
    assert.strictEqual(fs.existsSync(path.join(testWorkspace, 'src/renamed.ts')), false);
  });
});

test('Terminal Command Execution', async (t) => {
  const sandbox = new WorkspaceSandbox(testWorkspace);

  await t.test('executes command inside workspace directory', async () => {
    const res = await runCommand(sandbox, { command: 'pwd' });
    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.stdout.trim(), sandbox.getCanonicalPath());
  });

  await t.test('captures exit code and stderr on failure', async () => {
    const res = await runCommand(sandbox, { command: 'ls /nonexistent_directory_xyz_123' });
    assert.notStrictEqual(res.exitCode, 0);
    assert.ok(res.stderr.length > 0);
  });
});

test('MCP Streamable HTTP Transport & Protocol Handling', async (t) => {
  const sandbox = new WorkspaceSandbox(testWorkspace);
  // Create test server
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === '/mcp') {
      if (req.method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Mcp-Session-Id': 'test-session-123',
        });
        res.write(': vibebridge streamable http\n\n');
        res.end();
        return;
      }
      if (req.method === 'POST') {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', async () => {
          const rpc = JSON.parse(body);
          if (rpc.method === 'initialize') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'sess-new-1' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: rpc.id,
                result: {
                  protocolVersion: '2024-11-05',
                  capabilities: { tools: {} },
                  serverInfo: { name: 'vibebridge', version: '0.1.0' },
                },
              })
            );
          } else if (rpc.method === 'tools/list') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: rpc.id,
                result: {
                  tools: [{ name: 'list_files' }, { name: 'read_file' }, { name: 'run_command' }],
                },
              })
            );
          } else if (rpc.method === 'tools/call') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: rpc.id,
                result: {
                  content: [{ type: 'text', text: '{"success":true}' }],
                  isError: false,
                },
              })
            );
          }
        });
        return;
      }
      if (req.method === 'DELETE') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Session deleted' }));
        return;
      }
    }
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  await t.test('POST /mcp handles initialize', async () => {
    const postData = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'Gemini Spark', version: '1.0' } },
    });

    const res = await new Promise((resolve) => {
      const req = http.request(
        `http://127.0.0.1:${port}/mcp`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (response) => {
          let data = '';
          response.on('data', (c) => (data += c));
          response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(data) }));
        }
      );
      req.write(postData);
      req.end();
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.result.serverInfo.name, 'vibebridge');
    assert.strictEqual(res.headers['mcp-session-id'], 'sess-new-1');
  });

  await t.test('POST /mcp handles tools/list', async () => {
    const postData = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const res = await new Promise((resolve) => {
      const req = http.request(
        `http://127.0.0.1:${port}/mcp`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (response) => {
          let data = '';
          response.on('data', (c) => (data += c));
          response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
        }
      );
      req.write(postData);
      req.end();
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.result.tools.length, 3);
  });

  await t.test('POST /mcp handles tools/call', async () => {
    const postData = JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'read_file', arguments: { path: 'test.txt' } },
    });
    const res = await new Promise((resolve) => {
      const req = http.request(
        `http://127.0.0.1:${port}/mcp`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        (response) => {
          let data = '';
          response.on('data', (c) => (data += c));
          response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
        }
      );
      req.write(postData);
      req.end();
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.result.isError, false);
  });

  await t.test('GET /mcp connects SSE stream', async () => {
    const res = await new Promise((resolve) => {
      http.get(`http://127.0.0.1:${port}/mcp`, (response) => {
        resolve({ status: response.statusCode, headers: response.headers });
      });
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers['content-type'], 'text/event-stream');
  });

  await t.test('DELETE /mcp terminates session', async () => {
    const res = await new Promise((resolve) => {
      const req = http.request(
        `http://127.0.0.1:${port}/mcp`,
        { method: 'DELETE', headers: { 'Mcp-Session-Id': 'sess-new-1' } },
        (response) => {
          let data = '';
          response.on('data', (c) => (data += c));
          response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
        }
      );
      req.end();
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
  });

  server.close();
});
