/**
 * VibeBridge Structured Activity Logger
 * Safe logging with secret redaction and live event broadcasting.
 */

import { EventEmitter } from 'node:events';
import * as crypto from 'node:crypto';
import { ActivityLogItem, LogCategory, LogLevel } from '@vibebridge/shared';

const SENSITIVE_KEY_PATTERN = /(token|secret|password|authorization|key|bearer|authtoken|credential)/i;

export class StructuredActivityLogger extends EventEmitter {
  private logs: ActivityLogItem[] = [];
  private maxLogs = 1000;

  constructor() {
    super();
  }

  public log(level: LogLevel, category: LogCategory, message: string, metadata?: Record<string, any>): ActivityLogItem {
    const item: ActivityLogItem = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      level,
      category,
      message: this.sanitizeString(message),
      metadata: metadata ? this.sanitizeObject(metadata) : undefined,
    };

    this.logs.push(item);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    this.emit('log', item);
    return item;
  }

  public info(category: LogCategory, message: string, metadata?: Record<string, any>): ActivityLogItem {
    return this.log('info', category, message, metadata);
  }

  public warn(category: LogCategory, message: string, metadata?: Record<string, any>): ActivityLogItem {
    return this.log('warn', category, message, metadata);
  }

  public error(category: LogCategory, message: string, metadata?: Record<string, any>): ActivityLogItem {
    return this.log('error', category, message, metadata);
  }

  public debug(category: LogCategory, message: string, metadata?: Record<string, any>): ActivityLogItem {
    return this.log('debug', category, message, metadata);
  }

  public getRecentLogs(limit = 100): ActivityLogItem[] {
    return this.logs.slice(-limit);
  }

  public clear(): void {
    this.logs = [];
    this.emit('cleared');
  }

  private sanitizeString(str: string): string {
    if (!str || typeof str !== 'string') return str;
    // Redact Bearer tokens, ngrok tokens, etc.
    return str
      .replace(/Bearer\s+[a-zA-Z0-9_\-\.]{10,}/gi, 'Bearer [REDACTED]')
      .replace(/2[a-zA-Z0-9]{24,}_[a-zA-Z0-9]{15,}/g, '[NGROK_TOKEN_REDACTED]')
      .replace(/ghp_[a-zA-Z0-9]{30,}/g, '[GITHUB_TOKEN_REDACTED]');
  }

  private sanitizeObject(obj: any): any {
    if (!obj || typeof obj !== 'object') {
      return typeof obj === 'string' ? this.sanitizeString(obj) : obj;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.sanitizeObject(item));
    }

    const sanitized: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'string') {
        sanitized[key] = this.sanitizeString(value);
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = this.sanitizeObject(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
}
