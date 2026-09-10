/**
 * VibeBridge Core Runtime
 * Orchestrates Sandbox, MCP Server, Transport, Tunnel, Permissions, and Logging.
 */

import { EventEmitter } from 'node:events';
import {
  BridgeConfig,
  BridgeStatus,
  PermissionMode,
  PermissionGrantScope,
  ActivityLogItem,
  PermissionRequest,
} from '@vibebridge/shared';
import { WorkspaceSandbox, PermissionManager } from '@vibebridge/security';
import { McpServer } from './server';
import { StreamableHttpTransport } from './transport';
import { TunnelManager } from './tunnel';
import { StructuredActivityLogger } from './logger';

export class VibeBridgeRuntime extends EventEmitter {
  private config: BridgeConfig;
  private sandbox: WorkspaceSandbox | null = null;
  private permissionManager: PermissionManager;
  private logger: StructuredActivityLogger;
  private server: McpServer | null = null;
  private transport: StreamableHttpTransport | null = null;
  private tunnelManager: TunnelManager | null = null;
  private localUrl: string | null = null;
  private publicUrl: string | null = null;
  private isRunning = false;

  constructor(config: BridgeConfig) {
    super();
    this.config = { ...config };
    this.logger = new StructuredActivityLogger();
    this.permissionManager = new PermissionManager(this.config.permissionMode || 'prompt');

    this.logger.on('log', (item: ActivityLogItem) => {
      this.emit('log', item);
    });

    this.permissionManager.on('permission:request', (req: PermissionRequest) => {
      this.logger.warn('permission', `Permission requested: ${req.operation} on '${req.target}'`, req);
      this.emit('permission:request', req);
    });

    this.permissionManager.on('permission:decision', (req: PermissionRequest) => {
      this.logger.info('permission', `Permission decision: ${req.status} for ${req.operation} on '${req.target}'`, req);
      this.emit('permission:decision', req);
    });
  }

  public getLogger(): StructuredActivityLogger {
    return this.logger;
  }

  public getPermissionManager(): PermissionManager {
    return this.permissionManager;
  }

  public getConfig(): BridgeConfig {
    return { ...this.config };
  }

  public getStatus(): BridgeStatus {
    return {
      serverStatus: this.isRunning ? 'running' : 'stopped',
      tunnelStatus: this.tunnelManager ? this.tunnelManager.getStatus() : 'disconnected',
      localUrl: this.localUrl,
      publicUrl: this.publicUrl,
      mcpEndpoint: this.publicUrl ? `${this.publicUrl.replace(/\/+$/, '')}/mcp` : this.localUrl,
      workspacePath: this.sandbox ? this.sandbox.getCanonicalPath() : this.config.workspacePath,
      activeSessions: this.transport ? this.transport.getActiveSessionsCount() : 0,
      permissionMode: this.permissionManager.getMode(),
    };
  }

  /**
   * Updates workspace directory while runtime is running or stopped.
   */
  public setWorkspace(workspacePath: string): void {
    this.logger.info('server', `Setting workspace path to: ${workspacePath}`);
    const newSandbox = new WorkspaceSandbox(workspacePath);
    this.sandbox = newSandbox;
    this.config.workspacePath = newSandbox.getCanonicalPath();

    if (this.server) {
      this.server.updateSandbox(newSandbox);
    }

    this.emit('status', this.getStatus());
  }

  /**
   * Sets permission mode.
   */
  public setPermissionMode(mode: PermissionMode): void {
    this.config.permissionMode = mode;
    this.permissionManager.setMode(mode);
    this.logger.info('permission', `Permission mode set to: ${mode}`);
    this.emit('status', this.getStatus());
  }

  /**
   * Responds to an interactive permission request.
   * A session/workspace scope remembers the approval to avoid repeated prompts.
   */
  public respondPermission(
    id: string,
    allowed: boolean,
    scope: PermissionGrantScope = 'once'
  ): boolean {
    return this.permissionManager.respond(id, allowed, scope);
  }

  public async start(): Promise<BridgeStatus> {
    if (this.isRunning) {
      return this.getStatus();
    }

    this.logger.info('server', 'Starting VibeBridge runtime...');

    try {
      this.sandbox = new WorkspaceSandbox(this.config.workspacePath);
      this.logger.info('server', `Workspace verified at: ${this.sandbox.getCanonicalPath()}`);

      this.server = new McpServer(this.sandbox, this.permissionManager, this.logger);

      this.transport = new StreamableHttpTransport(this.server, this.logger);
      const listenResult = await this.transport.listen(this.config.port, this.config.host);
      this.localUrl = listenResult.localUrl;

      if (this.config.enableTunnel) {
        this.tunnelManager = new TunnelManager(
          this.logger,
          this.config.tunnelProvider === 'ngrok' ? 'ngrok' : 'direct',
          this.config.ngrokAuthToken
        );

        try {
          const tunnelResult = await this.tunnelManager.start(listenResult.port);
          this.publicUrl = tunnelResult.publicUrl;
        } catch (tunnelErr: any) {
          this.logger.warn('tunnel', `Tunnel startup failed: ${tunnelErr.message}. Local endpoint remains accessible.`);
        }
      }

      this.isRunning = true;
      const status = this.getStatus();
      this.emit('status', status);
      this.logger.info('server', `VibeBridge is ready. MCP Endpoint: ${status.mcpEndpoint}`);
      return status;
    } catch (err: any) {
      this.isRunning = false;
      this.logger.error('server', `Failed to start VibeBridge: ${err.message}`);
      throw err;
    }
  }

  public async stop(): Promise<BridgeStatus> {
    this.logger.info('server', 'Stopping VibeBridge runtime...');

    this.permissionManager.cancelAllPending();

    if (this.tunnelManager) {
      try {
        await this.tunnelManager.stop();
      } catch {}
      this.tunnelManager = null;
    }

    if (this.transport) {
      try {
        await this.transport.close();
      } catch {}
      this.transport = null;
    }

    this.isRunning = false;
    this.localUrl = null;
    this.publicUrl = null;
    this.server = null;

    const status = this.getStatus();
    this.emit('status', status);
    this.logger.info('server', 'VibeBridge runtime stopped successfully.');
    return status;
  }
}
