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
 * Helper to check if an authtoken string is a placeholder or invalid.
 */
function isPlaceholderToken(token?: string): boolean {
  if (!token) return true;
  const trimmed = token.trim();
  return (
    !trimmed ||
    trimmed === 'your_ngrok_auth_token_here' ||
    trimmed.startsWith('your_') ||
    trimmed.startsWith('<') ||
    trimmed.toLowerCase().includes('placeholder') ||
    trimmed.toLowerCase().startsWith('todo')
  );
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
    const rawToken = authtoken || process.env.NGROK_AUTHTOKEN;
    this.authtoken = isPlaceholderToken(rawToken) ? undefined : rawToken?.trim();
  }

  public getStatus(): TunnelStatus {
    return this.status;
  }

  public async start(port: number): Promise<TunnelResult> {
    this.status = 'connecting';
    this.logger.info('tunnel', `Starting ngrok tunnel for local port ${port}...`);

    // Quick check: If ngrok is already running on the system with an active tunnel for this port
    const existingUrl = await this.queryNgrokLocalApi(port);
    if (existingUrl) {
      this.publicUrl = existingUrl;
      this.status = 'connected';
      const mcpUrl = `${existingUrl.replace(/\/+$/, '')}/mcp`;
      this.logger.info('tunnel', `Existing ngrok tunnel detected and reused: ${mcpUrl}`);
      return { publicUrl: existingUrl, mcpUrl };
    }

    // First attempt: If @ngrok/ngrok is available in node environment
    try {
      const ngrok = await import('@ngrok/ngrok' as string);
      if (this.authtoken) {
        process.env.NGROK_AUTHTOKEN = this.authtoken;
      }
      const forwardOptions: any = { addr: port };
      if (this.authtoken) {
        forwardOptions.authtoken = this.authtoken;
      }
      const listener = await ngrok.forward(forwardOptions);

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
      let settled = false;
      let interval: NodeJS.Timeout | null = null;

      const finish = (result: TunnelResult) => {
        if (settled) return;
        settled = true;
        if (interval) {
          clearInterval(interval);
          interval = null;
        }
        resolve(result);
      };

      try {
        const args = ['http', String(port)];
        if (this.authtoken) {
          args.push(`--authtoken=${this.authtoken}`);
        }

        this.childProcess = spawn('ngrok', args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });

        let stderrOutput = '';
        this.childProcess.stderr?.on('data', (chunk) => {
          stderrOutput += chunk.toString();
        });

        this.childProcess.on('error', (err) => {
          this.status = 'error';
          this.logger.warn('tunnel', `ngrok binary not found in PATH or failed to spawn: ${err.message}`);
          const fallbackUrl = `http://localhost:${port}`;
          this.logger.warn('tunnel', `Falling back to local endpoint: ${fallbackUrl}`);
          finish({
            publicUrl: fallbackUrl,
            mcpUrl: `${fallbackUrl}/mcp`,
          });
        });

        this.childProcess.on('exit', async (code, signal) => {
          if (settled) return;

          // If ngrok exited because an existing tunnel was already running, check if it is active
          const activeUrl = await this.queryNgrokLocalApi(port);
          if (activeUrl) {
            this.publicUrl = activeUrl;
            this.status = 'connected';
            const mcpUrl = `${activeUrl.replace(/\/+$/, '')}/mcp`;
            this.logger.info('tunnel', `Ngrok tunnel established (reusing active tunnel): ${mcpUrl}`);
            finish({ publicUrl: activeUrl, mcpUrl });
            return;
          }

          this.status = 'error';
          const trimmedErr = stderrOutput.trim();
          const firstLineErr = trimmedErr ? trimmedErr.split('\n')[0] : `exit code ${code}`;
          this.logger.warn('tunnel', `ngrok process exited prematurely: ${firstLineErr}`);
          const fallbackUrl = `http://localhost:${port}`;
          this.logger.warn('tunnel', `Falling back to local endpoint: ${fallbackUrl}`);
          finish({
            publicUrl: fallbackUrl,
            mcpUrl: `${fallbackUrl}/mcp`,
          });
        });

        // Poll ngrok local management API for public URL
        let attempts = 0;
        const maxAttempts = 20;
        interval = setInterval(async () => {
          attempts++;
          try {
            const tunnelUrl = await this.queryNgrokLocalApi(port);
            if (tunnelUrl) {
              this.publicUrl = tunnelUrl;
              this.status = 'connected';
              const mcpUrl = `${tunnelUrl.replace(/\/+$/, '')}/mcp`;
              this.logger.info('tunnel', `Ngrok tunnel established via CLI: ${mcpUrl}`);
              finish({ publicUrl: tunnelUrl, mcpUrl });
              return;
            }
          } catch (err: any) {
            this.logger.debug('tunnel', `Error checking ngrok local API: ${err.message}`);
          }

          if (attempts >= maxAttempts) {
            this.status = 'error';
            const fallbackUrl = `http://localhost:${port}`;
            this.logger.warn('tunnel', `Could not obtain ngrok public URL after timeout. Using local: ${fallbackUrl}`);
            finish({ publicUrl: fallbackUrl, mcpUrl: `${fallbackUrl}/mcp` });
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
      try {
        this.childProcess.kill('SIGTERM');
      } catch {}
      this.childProcess = null;
    }
    this.status = 'disconnected';
    this.publicUrl = null;
    this.logger.info('tunnel', 'Ngrok tunnel stopped');
  }

  private queryNgrokLocalApi(port?: number): Promise<string | null> {
    return new Promise((resolve) => {
      const req = http.get('http://127.0.0.1:4040/api/tunnels', { timeout: 1500 }, (res) => {
        let raw = '';
        res.on('data', (chunk) => (raw += chunk));
        res.on('end', () => {
          try {
            const data = JSON.parse(raw);
            const tunnels = data.tunnels || [];
            if (port) {
              const portMatch = tunnels.find((t: any) => {
                const addr = String(t.config?.addr || '');
                return (
                  (addr === `http://localhost:${port}` ||
                    addr === `http://127.0.0.1:${port}` ||
                    addr.endsWith(`:${port}`)) &&
                  t.public_url &&
                  t.public_url.startsWith('https://')
                );
              });
              if (portMatch) {
                return resolve(portMatch.public_url);
              }
            }
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
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
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
