/**
 * VibeBridge Streamable HTTP MCP Transport
 * Implements modern Streamable HTTP MCP endpoint at /mcp with session management.
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
    const session: McpSession = {
      id,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    };
    this.sessions.set(id, session);
    this.logger.info('session', `Created new MCP session: ${id}`);
    return session;
  }

  public deleteSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    if (session.sseResponse && !session.sseResponse.writableEnded) {
      session.sseResponse.write('event: close\ndata: {"reason":"session_terminated"}\n\n');
      session.sseResponse.end();
    }

    this.sessions.delete(id);
    this.logger.info('session', `Terminated MCP session: ${id}`);
    return true;
  }

  /**
   * Starts listening on the specified host and port.
   */
  public async listen(port: number, host = '127.0.0.1'): Promise<{ port: number; host: string; localUrl: string }> {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => this.handleHttpRequest(req, res));

      this.httpServer.on('error', (err) => {
        this.logger.error('server', `HTTP Server error: ${err.message}`);
        reject(err);
      });

      this.httpServer.listen(port, host, () => {
        const addr = this.httpServer?.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        const localUrl = `http://${host}:${actualPort}/mcp`;
        this.logger.info('server', `VibeBridge MCP server listening on ${localUrl}`);

        // Setup periodic keepalive for open SSE streams
        this.pingInterval = setInterval(() => {
          this.broadcastSsePing();
        }, 15000);

        resolve({ port: actualPort, host, localUrl });
      });
    });
  }

  /**
   * Closes the HTTP server and all open client connections.
   */
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

  /**
   * Dispatches incoming HTTP requests to corresponding MCP endpoints.
   */
  private async handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);
    const pathname = url.pathname;
    const method = req.method?.toUpperCase();

    // Setup CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Mcp-Session-Id, Authorization, Accept');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

    if (method === 'OPTIONS') {
      res.statusCode = 204;
      res.end();
      return;
    }

    // Health and status inspection
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

    // Streamable HTTP endpoint: /mcp
    if (pathname === '/mcp') {
      const sessionIdHeader = (req.headers['mcp-session-id'] as string) || url.searchParams.get('sessionId') || '';

      if (method === 'GET') {
        await this.handleGetMcp(req, res, sessionIdHeader);
        return;
      }

      if (method === 'POST') {
        await this.handlePostMcp(req, res, sessionIdHeader);
        return;
      }

      if (method === 'DELETE') {
        await this.handleDeleteMcp(req, res, sessionIdHeader);
        return;
      }

      res.statusCode = 405;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    // Default 404
    res.statusCode = 404;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Not Found' }));
  }

  /**
   * Handles GET /mcp (Server-Sent Events for streaming messages/notifications).
   */
  private async handleGetMcp(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): Promise<void> {
    let session = sessionId ? this.sessions.get(sessionId) : undefined;
    if (!session) {
      session = this.createSession();
    }

    session.lastActiveAt = new Date().toISOString();

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Mcp-Session-Id', session.id);

    // Initial SSE connection handshake comment
    res.write(`: vibebridge streamable http connected\n\n`);
    res.write(`event: session\ndata: ${JSON.stringify({ sessionId: session.id })}\n\n`);

    session.sseResponse = res;

    req.on('close', () => {
      this.logger.debug('session', `SSE connection closed for session: ${session?.id}`);
      if (session && session.sseResponse === res) {
        session.sseResponse = undefined;
      }
    });
  }

  /**
   * Handles POST /mcp (JSON-RPC tool calls, requests, and notifications).
   */
  private async handlePostMcp(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): Promise<void> {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });

    req.on('end', async () => {
      try {
        if (!body.trim()) {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Empty request body' } }));
          return;
        }

        const rpcRequest = JSON.parse(body) as JsonRpcRequest;

        // Session resolution
        let session = sessionId ? this.sessions.get(sessionId) : undefined;
        if (!session) {
          // If initializing, create a session automatically
          session = this.createSession();
        }

        session.lastActiveAt = new Date().toISOString();
        res.setHeader('Mcp-Session-Id', session.id);

        const rpcResponse = await this.server.handleRequest(rpcRequest);

        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(rpcResponse));
      } catch (err: any) {
        this.logger.error('mcp_request', `Failed to parse or process POST /mcp: ${err.message}`);
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32700,
              message: `Parse error: ${err.message}`,
            },
          })
        );
      }
    });
  }

  /**
   * Handles DELETE /mcp (terminate session).
   */
  private async handleDeleteMcp(req: http.IncomingMessage, res: http.ServerResponse, sessionId: string): Promise<void> {
    if (!sessionId) {
      res.statusCode = 400;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Mcp-Session-Id header or query parameter required' }));
      return;
    }

    const deleted = this.deleteSession(sessionId);
    if (deleted) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ success: true, message: `Session ${sessionId} terminated` }));
    } else {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: `Session ${sessionId} not found` }));
    }
  }

  private broadcastSsePing(): void {
    for (const [, session] of this.sessions.entries()) {
      if (session.sseResponse && !session.sseResponse.writableEnded) {
        session.sseResponse.write(': keepalive\n\n');
      }
    }
  }
}
