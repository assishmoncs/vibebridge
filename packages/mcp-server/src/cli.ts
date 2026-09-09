#!/usr/bin/env node
/**
 * VibeBridge CLI
 * Standalone runner for launching the local MCP server bridge.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { VibeBridgeRuntime } from './bridge';
import { BridgeConfig, PermissionMode } from '@vibebridge/shared';

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
      workspacePath = args[++i];
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
  -h, --help                   Display this help message
      `);
      process.exit(0);
    }
  }

  // Verify workspace exists
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

  runtime.on('log', (item) => {
    const ts = item.timestamp.split('T')[1].slice(0, 8);
    const badge = item.level.toUpperCase().padEnd(5);
    console.log(`[${ts}] [${badge}] [${item.category}] ${item.message}`);
  });

  // CLI prompt handler for permissions if in prompt mode
  runtime.on('permission:request', (req) => {
    console.log('\n----------------- PERMISSION REQUIRED -----------------');
    console.log(`Operation: ${req.operation} (${req.category})`);
    console.log(`Target:    ${req.target}`);
    console.log(`Workspace: ${req.workingDirectory}`);
    if (req.details) {
      console.log(`Details:   ${JSON.stringify(req.details)}`);
    }
    console.log('------------------------------------------------------');

    // In auto_approve_read mode in CLI, if write occurs, auto-approve with warning or prompt
    if (config.permissionMode === 'auto_approve_read' || config.permissionMode === 'auto_approve_all') {
      console.log(`[Permission] Automatically allowing '${req.operation}' under current mode (${config.permissionMode})`);
      runtime.respondPermission(req.id, true);
    } else {
      console.log(`[Permission] Non-interactive CLI: Denying write operation '${req.operation}' by default for safety.`);
      runtime.respondPermission(req.id, false);
    }
  });

  try {
    const status = await runtime.start();
    console.log('\n========================================================');
    console.log(` Workspace:    ${status.workspacePath}`);
    console.log(` Local URL:    ${status.localUrl}`);
    if (status.publicUrl) {
      console.log(` Public URL:   ${status.publicUrl}`);
      console.log(` MCP Endpoint: ${status.mcpEndpoint}`);
    }
    console.log(` Permissions:  ${status.permissionMode}`);
    console.log('========================================================');
    console.log('\nProvide this MCP Endpoint to Gemini Spark to connect!\n');

    // Handle graceful shutdown
    const cleanup = async () => {
      console.log('\nShutting down VibeBridge...');
      await runtime.stop();
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  } catch (err: any) {
    console.error(`Failed to launch VibeBridge: ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
