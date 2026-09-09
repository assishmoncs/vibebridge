/**
 * VibeBridge Permission Gatekeeper
 * Controls authorization for read, write, and command execution operations.
 */

import { EventEmitter } from 'node:events';
import * as crypto from 'node:crypto';
import {
  ToolName,
  ToolCategory,
  PermissionMode,
  PermissionRequest,
  PermissionStatus,
} from '@vibebridge/shared';

export class PermissionDeniedError extends Error {
  constructor(message: string, public readonly details?: Record<string, any>) {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}

export interface PendingResolver {
  request: PermissionRequest;
  resolve: (allowed: boolean) => void;
  timer: NodeJS.Timeout;
}

export class PermissionManager extends EventEmitter {
  private mode: PermissionMode;
  private pendingRequests: Map<string, PendingResolver> = new Map();
  private requestTimeoutMs = 120000; // 2 minutes

  constructor(initialMode: PermissionMode = 'prompt') {
    super();
    this.mode = initialMode;
  }

  public getMode(): PermissionMode {
    return this.mode;
  }

  public setMode(newMode: PermissionMode): void {
    this.mode = newMode;
    this.emit('modeChanged', newMode);
  }

  /**
   * Determine category for a tool.
   */
  public static getToolCategory(toolName: ToolName): ToolCategory {
    switch (toolName) {
      case 'list_files':
      case 'read_file':
      case 'search_files':
        return 'read';
      case 'create_file':
      case 'edit_file':
      case 'delete_file':
      case 'move_file':
        return 'write';
      case 'run_command':
        return 'execute';
      default:
        return 'write';
    }
  }

  /**
   * Check or prompt for permission before running an operation.
   */
  public async authorize(
    operation: ToolName,
    target: string,
    workingDirectory: string,
    details?: Record<string, any>
  ): Promise<boolean> {
    const category = PermissionManager.getToolCategory(operation);

    // Rule 1: auto_approve_all approves everything
    if (this.mode === 'auto_approve_all') {
      return true;
    }

    // Rule 2: deny_writes rejects write and execute operations
    if (this.mode === 'deny_writes') {
      if (category === 'write' || category === 'execute') {
        throw new PermissionDeniedError(
          `Operation '${operation}' on '${target}' denied: VibeBridge is in strict read-only mode (deny_writes).`,
          { operation, target, category }
        );
      }
      return true; // reads allowed
    }

    // Rule 3: Read operations are auto-approved in prompt and auto_approve_read modes
    if (category === 'read') {
      return true;
    }

    // Rule 4: Write and Execute require explicit user approval
    const id = crypto.randomUUID();
    const request: PermissionRequest = {
      id,
      timestamp: new Date().toISOString(),
      operation,
      category,
      target,
      workingDirectory,
      details,
      status: 'pending',
    };

    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        request.status = 'denied';
        this.emit('permission:decision', { ...request, reason: 'Request timed out waiting for user response.' });
        reject(
          new PermissionDeniedError(
            `Operation '${operation}' on '${target}' timed out waiting for user approval.`,
            { operation, target, category }
          )
        );
      }, this.requestTimeoutMs);

      this.pendingRequests.set(id, {
        request,
        resolve: (allowed: boolean) => {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          request.status = allowed ? 'allowed' : 'denied';
          this.emit('permission:decision', request);
          if (allowed) {
            resolve(true);
          } else {
            reject(
              new PermissionDeniedError(
                `Operation '${operation}' on '${target}' was explicitly DENIED by user.`,
                { operation, target, category }
              )
            );
          }
        },
        timer,
      });

      // Notify UI or listeners
      this.emit('permission:request', request);
    });
  }

  /**
   * Responds to a pending permission request (from Desktop UI).
   */
  public respond(id: string, allowed: boolean): boolean {
    const resolver = this.pendingRequests.get(id);
    if (!resolver) {
      return false;
    }
    resolver.resolve(allowed);
    return true;
  }

  /**
   * Returns all currently pending permission requests.
   */
  public getPendingRequests(): PermissionRequest[] {
    return Array.from(this.pendingRequests.values()).map((r) => ({ ...r.request }));
  }

  /**
   * Cancel and reject all pending requests (e.g. on server stop).
   */
  public cancelAllPending(reason = 'Server shutting down'): void {
    for (const [id, resolver] of this.pendingRequests.entries()) {
      clearTimeout(resolver.timer);
      resolver.request.status = 'denied';
      resolver.resolve(false);
      this.pendingRequests.delete(id);
    }
  }
}
