/**
 * VibeBridge Terminal Execution Engine
 * Executes commands strictly within the workspace directory with output and time constraints.
 */

import { spawn } from 'node:child_process';
import { WorkspaceSandbox } from './sandbox';
import { RunCommandInput, RunCommandResult } from '@vibebridge/shared';

const MAX_OUTPUT_BYTES = 256 * 1024; // 256 KB safety cap for stdout / stderr

export class CommandExecutionError extends Error {
  constructor(message: string, public readonly code: string = 'COMMAND_EXEC_ERROR') {
    super(message);
    this.name = 'CommandExecutionError';
  }
}

/**
 * Runs a terminal command inside the workspace directory.
 */
export async function runCommand(
  sandbox: WorkspaceSandbox,
  input: RunCommandInput
): Promise<RunCommandResult> {
  const workspaceCwd = sandbox.getCanonicalPath();
  const command = input.command?.trim();

  if (!command) {
    throw new CommandExecutionError('Command cannot be empty', 'EMPTY_COMMAND');
  }

  const timeoutMs = Math.min(Math.max(1000, input.timeout_ms ?? 30000), 300000); // 1s to 5m

  const startTime = Date.now();

  return new Promise<RunCommandResult>((resolve) => {
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let isKilled = false;

    // Use platform-appropriate shell: bash/sh on Unix, cmd.exe / powershell on Windows
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
    const shellArgs = isWindows ? ['/d', '/s', '/c', command] : ['-c', command];

    const child = spawn(shell, shellArgs, {
      cwd: workspaceCwd,
      env: {
        ...process.env,
        PWD: workspaceCwd,
      },
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      isKilled = true;
      try {
        child.kill('SIGTERM');
        // Force kill if not terminated shortly
        setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {}
        }, 2000);
      } catch {}
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stdoutBuffer) < MAX_OUTPUT_BYTES) {
        stdoutBuffer += chunk.toString('utf-8');
        if (Buffer.byteLength(stdoutBuffer) >= MAX_OUTPUT_BYTES) {
          stdoutTruncated = true;
          stdoutBuffer += '\n[stdout truncated: exceeded 256KB output limit]';
        }
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (Buffer.byteLength(stderrBuffer) < MAX_OUTPUT_BYTES) {
        stderrBuffer += chunk.toString('utf-8');
        if (Buffer.byteLength(stderrBuffer) >= MAX_OUTPUT_BYTES) {
          stderrTruncated = true;
          stderrBuffer += '\n[stderr truncated: exceeded 256KB output limit]';
        }
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;
      resolve({
        command,
        workingDirectory: workspaceCwd,
        stdout: stdoutBuffer,
        stderr: (stderrBuffer ? stderrBuffer + '\n' : '') + `Execution error: ${err.message}`,
        exitCode: -1,
        durationMs,
        killed: isKilled,
        outputTruncated: stdoutTruncated || stderrTruncated,
      });
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startTime;

      let finalStderr = stderrBuffer;
      if (isKilled) {
        finalStderr += (finalStderr ? '\n' : '') + `[Command timed out after ${timeoutMs}ms]`;
      } else if (signal) {
        finalStderr += (finalStderr ? '\n' : '') + `[Process terminated with signal: ${signal}]`;
      }

      resolve({
        command,
        workingDirectory: workspaceCwd,
        stdout: stdoutBuffer,
        stderr: finalStderr,
        exitCode: code,
        durationMs,
        killed: isKilled,
        outputTruncated: stdoutTruncated || stderrTruncated,
      });
    });
  });
}
