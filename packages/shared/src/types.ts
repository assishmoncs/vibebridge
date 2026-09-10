/**
 * VibeBridge Shared Types
 * Common types across Desktop, MCP Server, Security, and Terminal execution layers.
 */

export type ToolCategory = 'read' | 'write' | 'execute';

export type ToolName =
  | 'list_files'
  | 'read_file'
  | 'search_files'
  | 'create_file'
  | 'edit_file'
  | 'delete_file'
  | 'move_file'
  | 'run_command';

export interface ToolDefinition {
  name: ToolName;
  description: string;
  category: ToolCategory;
  inputSchema: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
}

export type PermissionMode =
  | 'prompt'             // Prompt user for writes and command execution
  | 'auto_approve_read' // Auto-approve read ops, prompt for write & execute
  | 'auto_approve_all'  // Auto-approve everything (headless / full access)
  | 'deny_writes';      // Strict read-only mode, deny all write and execute

export type PermissionGrantScope =
  | 'once'       // Applies only to the current permission request
  | 'session'    // Applies until VibeBridge stops
  | 'workspace'; // Applies to the selected workspace for the current runtime

export type PermissionStatus = 'pending' | 'allowed' | 'denied';

export interface PermissionRequest {
  id: string;
  timestamp: string;
  operation: ToolName;
  category: ToolCategory;
  target: string;
  workingDirectory: string;
  details?: Record<string, any>;
  status: PermissionStatus;
}

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export type LogCategory =
  | 'server'
  | 'tunnel'
  | 'mcp_request'
  | 'tool_call'
  | 'file_op'
  | 'command_exec'
  | 'permission'
  | 'session';

export interface ActivityLogItem {
  id: string;
  timestamp: string;
  level: LogLevel;
  category: LogCategory;
  message: string;
  metadata?: Record<string, any>;
}

export interface ListFilesInput {
  path?: string;
  recursive?: boolean;
  include_hidden?: boolean;
  max_depth?: number;
  max_files?: number;
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedTime: string;
}

export interface ListFilesResult {
  path: string;
  files: FileEntry[];
  totalFiles: number;
  truncated: boolean;
}

export interface ReadFileInput {
  path: string;
  encoding?: string;
  line_offset?: number;
  line_count?: number;
}

export interface ReadFileResult {
  path: string;
  content: string;
  lines: number;
  sizeBytes: number;
  isTruncated?: boolean;
}

export interface SearchFilesInput {
  query: string;
  path?: string;
  file_pattern?: string;
  max_results?: number;
  case_sensitive?: boolean;
}

export interface SearchMatch {
  file: string;
  lineNumber: number;
  lineContent: string;
}

export interface SearchFilesResult {
  query: string;
  matches: SearchMatch[];
  totalMatches: number;
  truncated: boolean;
}

export interface CreateFileInput {
  path: string;
  content: string;
  overwrite?: boolean;
}

export interface CreateFileResult {
  path: string;
  bytesWritten: number;
  created: boolean;
}

export interface EditFileInput {
  path: string;
  old_text: string;
  new_text: string;
  replace_all?: boolean;
}

export interface EditFileResult {
  path: string;
  replacements: number;
  newSizeBytes: number;
}

export interface DeleteFileInput {
  path: string;
  recursive?: boolean;
}

export interface DeleteFileResult {
  path: string;
  deleted: boolean;
  isDirectory: boolean;
}

export interface MoveFileInput {
  source_path: string;
  destination_path: string;
  overwrite?: boolean;
}

export interface MoveFileResult {
  source_path: string;
  destination_path: string;
  success: boolean;
}

export interface RunCommandInput {
  command: string;
  timeout_ms?: number;
}

export interface RunCommandResult {
  command: string;
  workingDirectory: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
  killed?: boolean;
  outputTruncated?: boolean;
}

export interface BridgeConfig {
  workspacePath: string;
  port: number;
  host: string;
  enableTunnel: boolean;
  tunnelProvider: 'ngrok' | 'localtunnel' | 'cloudflare' | 'direct';
  ngrokAuthToken?: string;
  permissionMode: PermissionMode;
}

export interface BridgeStatus {
  serverStatus: 'stopped' | 'starting' | 'running' | 'error';
  tunnelStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
  localUrl: string | null;
  publicUrl: string | null;
  mcpEndpoint: string | null;
  workspacePath: string;
  activeSessions: number;
  permissionMode: PermissionMode;
  error?: string;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}
