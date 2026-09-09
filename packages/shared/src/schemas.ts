/**
 * VibeBridge Input Validation Schemas
 * Validates tool parameters, MCP messages, and configuration.
 */

import { z } from 'zod';

export const ListFilesSchema = z.object({
  path: z.string().optional().default(''),
  recursive: z.boolean().optional().default(false),
  include_hidden: z.boolean().optional().default(false),
  max_depth: z.number().int().positive().max(50).optional().default(10),
  max_files: z.number().int().positive().max(5000).optional().default(1000),
});

export const ReadFileSchema = z.object({
  path: z.string().min(1, 'Path is required'),
  encoding: z.string().optional().default('utf-8'),
  line_offset: z.number().int().nonnegative().optional(),
  line_count: z.number().int().positive().max(10000).optional(),
});

export const SearchFilesSchema = z.object({
  query: z.string().min(1, 'Search query cannot be empty'),
  path: z.string().optional().default(''),
  file_pattern: z.string().optional(),
  max_results: z.number().int().positive().max(1000).optional().default(100),
  case_sensitive: z.boolean().optional().default(false),
});

export const CreateFileSchema = z.object({
  path: z.string().min(1, 'Path is required'),
  content: z.string(),
  overwrite: z.boolean().optional().default(false),
});

export const EditFileSchema = z.object({
  path: z.string().min(1, 'Path is required'),
  old_text: z.string(),
  new_text: z.string(),
  replace_all: z.boolean().optional().default(false),
});

export const DeleteFileSchema = z.object({
  path: z.string().min(1, 'Path is required'),
  recursive: z.boolean().optional().default(false),
});

export const MoveFileSchema = z.object({
  source_path: z.string().min(1, 'source_path is required'),
  destination_path: z.string().min(1, 'destination_path is required'),
  overwrite: z.boolean().optional().default(false),
});

export const RunCommandSchema = z.object({
  command: z.string().min(1, 'Command is required'),
  timeout_ms: z.number().int().positive().max(300000).optional().default(30000),
});

export const BridgeConfigSchema = z.object({
  workspacePath: z.string().min(1, 'Workspace path is required'),
  port: z.number().int().min(1024).max(65535).default(3000),
  host: z.string().default('127.0.0.1'),
  enableTunnel: z.boolean().default(true),
  tunnelProvider: z.enum(['ngrok', 'localtunnel', 'cloudflare', 'direct']).default('ngrok'),
  ngrokAuthToken: z.string().optional(),
  permissionMode: z.enum(['prompt', 'auto_approve_read', 'auto_approve_all', 'deny_writes']).default('prompt'),
});

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.any()).optional(),
});
