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
  PermissionGrantScope,
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
  private sessionGrants: Set<ToolCategory> = new Set();
  private workspaceGrants: Map<string, Set<ToolCategory>> = new Map();
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
   * Checks whether an operation already has a remembered grant.
   * Session grants follow the running VibeBridge process. Workspace grants
   * apply only to the currently selected workspace path.
   */
  private hasGrant(category: ToolCategory, workingDirectory: string): boolean {
    if (this.sessionGrants.has(category)) {
      return true;
    }

    const workspaceGrant = this.workspaceGrants.get(workingDirectory);
    return Boolean(workspaceGrant?.has(category));
  }

  /**
   * Remembers an approval at the requested scope.
   */
  public grant(category: ToolCategory, scope: PermissionGrantScope, workingDirectory: string): void {
    if (scope === 'once') {
      return;
    }

    if (scope === 'session') {
      this.sessionGrants.add(category);
      return;
    }

    const grants = this.workspaceGrants.get(workingDirectory) || new Set<ToolCategory>();
    grants.add(category);
    this.workspaceGrants.set(workingDirectory, grants);
  }

  /**
   * Revokes a remembered grant for a category and scope.
   */
  public revoke(category: ToolCategory, scope: Exclude<PermissionGrantScope, 'once'>, workingDirectory?: string): void {
    if (scope === 'session') {
      this.sessionGrants.delete(category);
      return;
    }

    if (!workingDirectory) {
      return;
    }

    const grants = this.workspaceGrants.get(workingDirectory);
    if (!grants) {
      return;
    }

    grants.delete(category);
    if (grants.size === 0) {
      this.workspaceGrants.delete(workingDirectory);
    }
  }

  /**
   * Determine whether an operation would currently be allowed without a prompt.
   */
  public isGranted(operation: ToolName, workingDirectory: string): boolean {
    const category = PermissionManager.getToolCategory(operation);
    return this.hasGrant(category, workingDirectory);
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

    // Rule 1: full access mode approves everything.
    if (this.mode === 'auto_approve_all') {
      return true;
    }

    // Rule 2: remembered grants avoid repeated prompts.
    if (this.hasGrant(category, workingDirectory)) {
      return true;
    }

    // Rule 3: deny_writes rejects write and execute operations.
    if (this.mode === 'deny_writes') {
      if (category === 'write' || category === 'execute') {
        throw new PermissionDeniedError(
          `Operation '${operation}' on '${target}' denied: VibeBridge is in strict read-only mode (deny_writes).`,
          { operation, target, category }
        );
      }
      return true; // reads allowed
    }

    // Rule 4: read operations are auto-approved in prompt and auto_approve_read modes.
    if (category === 'read') {
      return true;
    }

    // Rule 5: write and execute require explicit approval unless remembered above.
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

      this.emit('permission:request', request);
    });
  }

  /**
   * Responds to a pending permission request and optionally remembers the approval.
   */
  public respond(
    id: string,
    allowed: boolean,
    scope: PermissionGrantScope = 'once'
  ): boolean {
    const resolver = this.pendingRequests.get(id);
    if (!resolver) {
      return false;
    }

    if (allowed && scope !== 'once') {
      this.grant(resolver.request.category, scope, resolver.request.workingDirectory);
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
