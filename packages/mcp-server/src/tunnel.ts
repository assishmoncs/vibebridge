/**
 * VibeBridge Tunnel Manager
 * Pluggable tunnel provider for exposing local MCP server over HTTPS to Gemini Spark.
 */

import { EventEmitter } from 'node:events';
import { spawn, ChildProcess } from 'node:child_process';
import * as http from 'node:http';
import { StructuredActivityLogger } from './logger';

export type TunnelStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface TunnelResult {
  publicUrl: string;
  mcpUrl: string;
}

export interface TunnelProvider {
  readonly name: string;
  start(port: number): Promise<TunnelResult>;
  stop(): Promise<void>;
  getStatus(): TunnelStatus;
}

/**
 * Ngrok tunnel provider supporting both the official SDK and the ngrok CLI.
 */
export class NgrokTunnelProvider implements TunnelProvider {
  public readonly name = 'ngrok';
  private status: TunnelStatus = 'disconnected';
  private publicUrl: string | null = null;
  private childProcess: ChildProcess | null = null;
  private authtoken?: string;
  private logger: StructuredActivityLogger;

  constructor(logger: StructuredActivityLogger, authtoken?: string) {
    this.logger = logger;
    this.authtoken = authtoken || process.env.NGROK_AUTHTOKEN;
  }

  public getStatus(): TunnelStatus {
    return this.status;
  }

  public async start(port: number): Promise<TunnelResult> {
    this.status = 'connecting';
    this.logger.info('tunnel', `Starting ngrok tunnel for local port ${port}...`);

    // First attempt: If @ngrok/ngrok is available in node environment
    try {
      const ngrok = await import('@ngrok/ngrok' as string);
      if (this.authtoken) {
        process.env.NGROK_AUTHTOKEN = this.authtoken;
      }
      const listener = await ngrok.forward({
        addr: port,
        authtoken: this.authtoken,
      });

      const url = listener.url();
      if (url) {
        this.publicUrl = url;
        this.status = 'connected';
        const mcpUrl = `${url.replace(/\/+$/, '')}/mcp`;
        this.logger.info('tunnel', `Ngrok tunnel established via SDK: ${mcpUrl}`);
        return { publicUrl: url, mcpUrl };
      }
    } catch (err: any) {
      this.logger.debug('tunnel', `@ngrok/ngrok SDK not available or failed: ${err.message}. Falling back to ngrok CLI.`);
    }

    // Second attempt: Launch ngrok CLI process
    return new Promise((resolve, reject) => {
      try {
        const args = ['http', String(port)];
        if (this.authtoken) {
          args.push(`--authtoken=${this.authtoken}`);
        }

        this.childProcess = spawn('ngrok', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });

        this.childProcess.on('error', (err) => {
          this.status = 'error';
          this.logger.warn('tunnel', `ngrok binary not found in PATH or failed to spawn: ${err.message}`);
          // Fallback to local endpoint if ngrok fails
          const fallbackUrl = `http://localhost:${port}`;
          resolve({
            publicUrl: fallbackUrl,
            mcpUrl: `${fallbackUrl}/mcp`,
          });
        });

        // Poll ngrok local management API for public URL
        let attempts = 0;
        const maxAttempts = 20;
        const interval = setInterval(async () => {
          attempts++;
          try {
            const tunnelUrl = await this.queryNgrokLocalApi();
            if (tunnelUrl) {
              clearInterval(interval);
              this.publicUrl = tunnelUrl;
              this.status = 'connected';
              const mcpUrl = `${tunnelUrl.replace(/\/+$/, '')}/mcp`;
              this.logger.info('tunnel', `Ngrok tunnel established via CLI: ${mcpUrl}`);
              resolve({ publicUrl: tunnelUrl, mcpUrl });
            }
          } catch {
            if (attempts >= maxAttempts) {
              clearInterval(interval);
              this.status = 'error';
              const fallbackUrl = `http://localhost:${port}`;
              this.logger.warn('tunnel', `Could not obtain ngrok public URL after timeout. Using local: ${fallbackUrl}`);
              resolve({ publicUrl: fallbackUrl, mcpUrl: `${fallbackUrl}/mcp` });
            }
          }
        }, 500);
      } catch (err: any) {
        this.status = 'error';
        this.logger.error('tunnel', `Error launching ngrok: ${err.message}`);
        reject(err);
      }
    });
  }

  public async stop(): Promise<void> {
    if (this.childProcess) {
      this.childProcess.kill('SIGTERM');
      this.childProcess = null;
    }
    this.status = 'disconnected';
    this.publicUrl = null;
    this.logger.info('tunnel', 'Ngrok tunnel stopped');
  }

  private queryNgrokLocalApi(): Promise<string | null> {
    return new Promise((resolve) => {
      const req = http.get('http://127.0.0.1:4040/api/tunnels', { timeout: 1000 }, (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            const tunnels = data.tunnels || [];
            const httpsTunnel = tunnels.find((t: any) => t.public_url && t.public_url.startsWith('https://'));
            if (httpsTunnel) {
              resolve(httpsTunnel.public_url);
            } else if (tunnels.length > 0 && tunnels[0].public_url) {
              resolve(tunnels[0].public_url);
            } else {
              resolve(null);
            }
          } catch {
            resolve(null);
          }
        });
      });
      req.on('error', () => resolve(null));
    });
  }
}

/**
 * Direct HTTP provider (used for local testing or custom reverse proxy).
 */
export class DirectTunnelProvider implements TunnelProvider {
  public readonly name = 'direct';
  private status: TunnelStatus = 'disconnected';
  private port: number = 3000;

  constructor(private logger: StructuredActivityLogger) {}

  public getStatus(): TunnelStatus {
    return this.status;
  }

  public async start(port: number): Promise<TunnelResult> {
    this.port = port;
    this.status = 'connected';
    const publicUrl = `http://127.0.0.1:${port}`;
    const mcpUrl = `${publicUrl}/mcp`;
    this.logger.info('tunnel', `Direct local provider active: ${mcpUrl}`);
    return { publicUrl, mcpUrl };
  }

  public async stop(): Promise<void> {
    this.status = 'disconnected';
  }
}

/**
 * High-level manager coordinating tunnel lifecycle.
 */
export class TunnelManager extends EventEmitter {
  private currentProvider: TunnelProvider;
  private logger: StructuredActivityLogger;
  private currentResult: TunnelResult | null = null;

  constructor(logger: StructuredActivityLogger, providerName: 'ngrok' | 'direct' = 'ngrok', ngrokToken?: string) {
    super();
    this.logger = logger;
    this.currentProvider =
      providerName === 'ngrok'
        ? new NgrokTunnelProvider(logger, ngrokToken)
        : new DirectTunnelProvider(logger);
  }

  public setProvider(provider: TunnelProvider): void {
    this.currentProvider = provider;
    this.emit('providerChanged', provider.name);
  }

  public getStatus(): TunnelStatus {
    return this.currentProvider.getStatus();
  }

  public getResult(): TunnelResult | null {
    return this.currentResult;
  }

  public async start(port: number): Promise<TunnelResult> {
    try {
      this.currentResult = await this.currentProvider.start(port);
      this.emit('connected', this.currentResult);
      return this.currentResult;
    } catch (err: any) {
      this.emit('error', err);
      throw err;
    }
  }

  public async stop(): Promise<void> {
    await this.currentProvider.stop();
    this.currentResult = null;
    this.emit('disconnected');
  }
}
