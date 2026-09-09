/**
 * VibeBridge Streamable HTTP MCP Transport
 * Implements the VibeBridge HTTP endpoint at /mcp with session management.
 */

import * as http from 'node:http';
import * as crypto from 'node:crypto';
import { McpServer } from './server';
import { StructuredActivityLogger } from './logger';
import { JsonRpcRequest } from '@vibebridge/shared';

export interface McpSession {
  id: string;
  createdAt: string;
  lastActiveAt: string;
  sseResponse?: http.ServerResponse;
}

export class StreamableHttpTransport {
  private server: McpServer;
  private logger: StructuredActivityLogger;
  private httpServer: http.Server | null = null;
  private sessions: Map<string, McpSession> = new Map();
  private pingInterval: NodeJS.Timeout | null = null;

  constructor(server: McpServer, logger: StructuredActivityLogger) {
    this.server = server;
    this.logger = logger;
  }

  public getActiveSessionsCount(): number {
    return this.sessions.size;
  }

  public getSession(id: string): McpSession | undefined {
    return this.sessions.get(id);
  }

  public createSession(): McpSession {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const session: McpSession = {
      id,
      createdAt: now,
      lastActiveAt: now,
    };

    this.sessions.set(id, session);
    this.logger.info('session', `Created new MCP session: ${id}`);
    return session;
  }

  public deleteSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    if (session.sseResponse && !session.sseResponse.writableEnded) {
      session.sseResponse.write(
        'event: close\ndata:{"reason":"session_terminated"}\n\n'
      );
      session.sseResponse.end();
    }

    this.sessions.delete(id);
    this.logger.info('session', `Terminated MCP session: ${id}`);
    return true;
  }

  /** Start the local HTTP listener. */
  public async listen(
    port: number,
    host = '127.0.0.1'
  ): Promise<{ port: number; host: string; localUrl: string }> {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => {
        void this.handleHttpRequest(req, res);
      });

      this.httpServer.on('error', (err) => {
        this.logger.error('server', `HTTP Server error: ${err.message}`);
        reject(err);
      });

      this.httpServer.listen(port, host, () => {
        const addr = this.httpServer?.address();
        const actualPort =
          typeof addr === 'object' && addr ? addr.port : port;
        const localUrl = `http://${host}:${actualPort}/mcp`;

        this.logger.info(
          'server',
          `VibeBridge MCP server listening on ${localUrl}`
        );

        this.pingInterval = setInterval(() => {
          this.broadcastSsePing();
        }, 15000);

        resolve({
          port: actualPort,
          host,
          localUrl,
        });
      });
    });
  }

  /** Close the HTTP server and all sessions. */
  public async close(): Promise<void> {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    for (const [id] of this.sessions.entries()) {
      this.deleteSession(id);
    }

    return new Promise((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => {
          this.httpServer = null;
          this.logger.info('server', 'VibeBridge MCP server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  private async handleHttpRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<void> {
    const url = new URL(
      req.url || '/',
      `http://${req.headers.host || '127.0.0.1'}`
    );

    const pathname = url.pathname;
    const method = (req.method || 'GET').toUpperCase();

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
      'Access-Control-Allow-Methods',
      'GET, POST, DELETE, OPTIONS, HEAD'
    );
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, Mcp-Session-Id, Authorization, Accept, Last-Event-ID'
    );
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Mcp-Session-Id'
    );

    if (method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (pathname === '/health' || pathname === '/status') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          status: 'ok',
          name: 'vibebridge',
          version: '0.1.0',
          activeSessions: this.sessions.size,
        })
      );
      return;
    }

    // Gemini/Spark may probe the MCP endpoint with HEAD first.
    if (pathname === '/mcp' && method === 'HEAD') {
      this.logger.info('mcp_request', 'HEAD /mcp probe');
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end();
      return;
    }

    if (pathname === '/mcp') {
      const sessionId =
        (req.headers['mcp-session-id'] as string | undefined) ||
        url.searchParams.get('sessionId') ||
        '';

      if (method === 'GET') {
        await this.handleGetMcp(req, res, sessionId);
        return;
      }

      if (method === 'POST') {
        await this.handlePostMcp(req, res, sessionId);
        return;
      }

      if (method === 'DELETE') {
        await this.handleDeleteMcp(req, res, sessionId);
        return;
      }

      res.statusCode = 405;
      res.setHeader('Allow', 'GET, POST, DELETE, HEAD, OPTIONS');
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not Found' }));
  }

  /** Handle GET /mcp for an existing session. */
  private async handleGetMcp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    sessionId: string
  ): Promise<void> {
    if (!sessionId) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: 'Mcp-Session-Id header or sessionId query parameter required',
        })
      );
      return;
    }

    const session = this.sessions.get(sessionId);

    if (!session) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'MCP session not found' }));
      return;
    }

    session.lastActiveAt = new Date().toISOString();

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Mcp-Session-Id', session.id);

    res.write(': vibebridge streamable http connected\n\n');
    session.sseResponse = res;

    req.on('close', () => {
      this.logger.debug(
        'session',
        `SSE connection closed for session: ${session.id}`
      );

      if (session.sseResponse === res) {
        session.sseResponse = undefined;
      }
    });
  }

  /** Handle POST /mcp. */
  private async handlePostMcp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    sessionId: string
  ): Promise<void> {
    const body = await this.readRequestBody(req);

    if (!body.trim()) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32700,
            message: 'Empty request body',
          },
        })
      );
      return;
    }

    let rpcRequest: JsonRpcRequest;

    try {
      rpcRequest = JSON.parse(body) as JsonRpcRequest;
    } catch (err: any) {
      this.logger.error(
        'mcp_request',
        `Invalid JSON received: ${err.message}`
      );

      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32700,
            message: 'Parse error',
          },
        })
      );
      return;
    }

    const isInitialize = rpcRequest.method === 'initialize';

    // A new session is only created by an initialize request.
    if (!sessionId && !isInitialize) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpcRequest.id ?? null,
          error: {
            code: -32000,
            message:
              'No MCP session. The first request must be initialize.',
          },
        })
      );
      return;
    }

    let session = sessionId
      ? this.sessions.get(sessionId)
      : undefined;

    if (sessionId && !session) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpcRequest.id ?? null,
          error: {
            code: -32000,
            message: 'MCP session not found',
          },
        })
      );
      return;
    }

    if (!session) {
      session = this.createSession();
    }

    session.lastActiveAt = new Date().toISOString();
    res.setHeader('Mcp-Session-Id', session.id);

    try {
      const rpcResponse = await this.server.handleRequest(rpcRequest);

      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(rpcResponse));
    } catch (err: any) {
      this.logger.error(
        'mcp_request',
        `Failed to process ${rpcRequest.method}: ${err.message}`
      );

      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: rpcRequest.id ?? null,
          error: {
            code: -32603,
            message: err.message,
          },
        })
      );
    }
  }

  /** Handle DELETE /mcp. */
  private async handleDeleteMcp(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    sessionId: string
  ): Promise<void> {
    if (!sessionId) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          error: 'Mcp-Session-Id header or sessionId query parameter required',
        })
      );
      return;
    }

    if (!this.sessions.has(sessionId)) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'MCP session not found' }));
      return;
    }

    this.deleteSession(sessionId);

    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ success: true }));
  }

  private readRequestBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';

      req.setEncoding('utf8');

      req.on('data', (chunk) => {
        body += chunk;

        if (Buffer.byteLength(body, 'utf8') > 10 * 1024 * 1024) {
          reject(new Error('Request body exceeds 10 MB limit.'));
          req.destroy();
        }
      });

      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  private broadcastSsePing(): void {
    for (const [, session] of this.sessions.entries()) {
      if (
        session.sseResponse &&
        !session.sseResponse.writableEnded
      ) {
        session.sseResponse.write(': keepalive\n\n');
      }
    }
  }
}
