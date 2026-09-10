#!/usr/bin/env node
/**
 * VibeBridge CLI
 * Standalone runner for launching the local MCP server bridge.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { VibeBridgeRuntime } from './bridge';
import { BridgeConfig, PermissionMode, PermissionGrantScope } from '@vibebridge/shared';

function printBanner() {
  console.log(`
========================================================================
   __     ___ _          ____       _     _             
   \\ \\   / (_) |__   ___| __ ) _ __(_) __| | __ _  ___  
    \\ \\ / /| | '_ \\ / _ \\  _ \\| '__| |/ _\` |/ _\` |/ _ \\ 
     \\ V / | | |_) |  __/ |_) | |  | | (_| | (_| |  __/ 
      \\_/  |_|_.__/ \\___|____/|_|  |_|\\__,_|\\__, |\\___| 
                                            |___/       
        Local MCP Execution Bridge for Gemini Spark
========================================================================
`);
}

function parseArgs(): BridgeConfig {
  const args = process.argv.slice(2);
  let workspacePath = process.env.VIBEBRIDGE_WORKSPACE || process.cwd();
  let port = Number(process.env.PORT) || 3000;
  let host = process.env.HOST || '127.0.0.1';
  let enableTunnel = process.env.ENABLE_TUNNEL !== 'false';
  let tunnelProvider: 'ngrok' | 'direct' = (process.env.TUNNEL_PROVIDER as any) || 'ngrok';
  let ngrokAuthToken = process.env.NGROK_AUTHTOKEN;
  let permissionMode: PermissionMode = (process.env.PERMISSION_MODE as PermissionMode) || 'auto_approve_read';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--workspace' || arg === '-w') {
      const next = args[++i];
      if (!next) {
        console.error('Error: --workspace requires a directory path.');
        process.exit(1);
      }
      workspacePath = next;
    } else if (arg === '--port' || arg === '-p') {
      port = Number(args[++i]);
    } else if (arg === '--host') {
      host = args[++i];
    } else if (arg === '--no-tunnel') {
      enableTunnel = false;
    } else if (arg === '--tunnel') {
      tunnelProvider = args[++i] as any;
    } else if (arg === '--ngrok-token') {
      ngrokAuthToken = args[++i];
    } else if (arg === '--permission-mode') {
      permissionMode = args[++i] as PermissionMode;
    } else if (arg === '--full-access') {
      permissionMode = 'auto_approve_all';
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: vibebridge [options]

Options:
  -w, --workspace <path>       Local workspace directory (default: current directory)
  -p, --port <port>            Local port to listen on (default: 3000)
  --host <host>                Local host binding (default: 127.0.0.1)
  --tunnel <ngrok|direct>      Tunnel provider (default: ngrok)
  --no-tunnel                  Disable public tunnel creation
  --ngrok-token <token>        ngrok authentication token
  --permission-mode <mode>     Permission mode: prompt, auto_approve_read, auto_approve_all, deny_writes
  --full-access                Shortcut for --permission-mode auto_approve_all
  -h, --help                   Display this help message
      `);
      process.exit(0);
    }
  }

  const absPath = path.resolve(workspacePath);
  if (!fs.existsSync(absPath)) {
    console.error(`Error: Workspace path does not exist: ${absPath}`);
    process.exit(1);
  }

  return {
    workspacePath: absPath,
    port,
    host,
    enableTunnel,
    tunnelProvider: tunnelProvider === 'ngrok' ? 'ngrok' : 'direct',
    ngrokAuthToken,
    permissionMode,
  };
}

async function main() {
  printBanner();
  const config = parseArgs();
  const runtime = new VibeBridgeRuntime(config);
  const rl = readline.createInterface({ input, output });

  runtime.on('log', (item) => {
    const ts = item.timestamp.split('T')[1].slice(0, 8);
    const badge = item.level.toUpperCase().padEnd(5);
    console.log(`[${ts}] [${badge}] [${item.category}] ${item.message}`);
  });

  // Serialize prompts so concurrent tool requests do not create overlapping questions.
  let permissionPromptQueue = Promise.resolve();
  runtime.on('permission:request', (req) => {
    permissionPromptQueue = permissionPromptQueue
      .then(async () => {
        console.log('\n----------------- PERMISSION REQUIRED -----------------');
        console.log(`Operation: ${req.operation} (${req.category})`);
        console.log(`Target:    ${req.target}`);
        console.log(`Workspace: ${req.workingDirectory}`);
        if (req.details) {
          console.log(`Details:   ${JSON.stringify(req.details)}`);
        }
        console.log('--------------------------------------------------------');

        if (config.permissionMode === 'auto_approve_all') {
          console.log(`[Permission] Automatically allowing '${req.operation}' (full access)`);
          runtime.respondPermission(req.id, true, 'session');
          return;
        }

        if (!input.isTTY || !output.isTTY) {
          console.log(`[Permission] Non-interactive CLI: denying '${req.operation}' by default.`);
          runtime.respondPermission(req.id, false);
          return;
        }

        console.log('Choose: [o] Once  [s] Session  [w] Workspace  [d] Deny');
        const answer = (await rl.question('Permission: ')).trim().toLowerCase();
        const choice = answer[0];

        const scope: PermissionGrantScope = choice === 's'
          ? 'session'
          : choice === 'w'
            ? 'workspace'
            : 'once';
        const allowed = choice === 'o' || choice === 's' || choice === 'w';

        if (!allowed) {
          console.log(`[Permission] Denied '${req.operation}'.`);
          runtime.respondPermission(req.id, false);
          return;
        }

        console.log(`[Permission] Allowed '${req.operation}' for ${scope}.`);
        runtime.respondPermission(req.id, true, scope);
      })
      .catch((err) => {
        console.error(`[Permission] Failed to handle request: ${err.message}`);
        runtime.respondPermission(req.id, false);
      });
  });

  try {
    const status = await runtime.start();
    console.log('\n========================================================');
    console.log(` Workspace:    ${status.workspacePath}`);
    console.log(` Local URL:    ${status.localUrl}`);
    if (status.tunnelStatus === 'connected' && status.publicUrl && !status.publicUrl.includes('localhost') && !status.publicUrl.includes('127.0.0.1')) {
      console.log(` Public URL:   ${status.publicUrl}`);
      console.log(` MCP Endpoint: ${status.mcpEndpoint}`);
    } else {
      console.log(` Tunnel:       Local fallback (${status.tunnelStatus})`);
      console.log(` MCP Endpoint: ${status.mcpEndpoint}`);
    }
    console.log(` Permissions:  ${status.permissionMode}`);
    console.log('========================================================');
    console.log('\nProvide this MCP Endpoint to Gemini Spark to connect!\n');

    const cleanup = async () => {
      console.log('\nShutting down VibeBridge...');
      rl.close();
      await runtime.stop();
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  } catch (err: any) {
    rl.close();
    console.error(`Failed to launch VibeBridge: ${err.message}`);
    process.exit(1);
  }
}

void main();
