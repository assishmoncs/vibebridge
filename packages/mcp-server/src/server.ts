/**
 * VibeBridge MCP Server
 * Exposes workspace tools to Gemini Spark over the Model Context Protocol (MCP).
 */

import {
  ToolDefinition,
  ToolName,
  JsonRpcRequest,
  JsonRpcResponse,
} from '@vibebridge/shared';
import {
  ListFilesSchema,
  ReadFileSchema,
  SearchFilesSchema,
  CreateFileSchema,
  EditFileSchema,
  DeleteFileSchema,
  MoveFileSchema,
  RunCommandSchema,
} from '@vibebridge/shared';
import {
  WorkspaceSandbox,
  listFiles,
  readFile,
  searchFiles,
  createFile,
  editFile,
  deleteFile,
  moveFile,
  runCommand,
  PermissionManager,
} from '@vibebridge/security';
import { StructuredActivityLogger } from './logger';

export const VIBEBRIDGE_TOOLS: ToolDefinition[] = [
  {
    name: 'list_files',
    description: 'List files and subdirectories within a workspace directory path. Returns name, relative path, size, and type.',
    category: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path within the workspace to list. Empty string or omit for workspace root.',
        },
        recursive: {
          type: 'boolean',
          description: 'Whether to list files recursively. Default is false.',
        },
        include_hidden: {
          type: 'boolean',
          description: 'Whether to include hidden files (names starting with dot). Default is false.',
        },
        max_depth: {
          type: 'integer',
          description: 'Maximum subdirectory depth for recursive listing. Default is 10.',
        },
        max_files: {
          type: 'integer',
          description: 'Maximum number of files to return. Default is 1000.',
        },
      },
    },
  },
  {
    name: 'read_file',
    description: 'Read the text content of a file in the workspace. Supports optional line-based pagination for large files.',
    category: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the file within the workspace.',
        },
        encoding: {
          type: 'string',
          description: 'Character encoding to use (default: utf-8).',
        },
        line_offset: {
          type: 'integer',
          description: 'Zero-based starting line number for partial reading.',
        },
        line_count: {
          type: 'integer',
          description: 'Number of lines to read from the offset.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_files',
    description: 'Search for text or regex patterns across files in the workspace. Returns matching files, line numbers, and contents.',
    category: 'read',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Text or substring to search for in files.',
        },
        path: {
          type: 'string',
          description: 'Optional subfolder to restrict search to.',
        },
        file_pattern: {
          type: 'string',
          description: 'Optional file extension or pattern to filter (e.g. *.ts, *.json).',
        },
        max_results: {
          type: 'integer',
          description: 'Maximum number of line matches to return. Default is 100.',
        },
        case_sensitive: {
          type: 'boolean',
          description: 'Whether the search should be case sensitive. Default is false.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'create_file',
    description: 'Create a new file in the workspace with the specified content. Automatically creates parent folders if missing.',
    category: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path where the new file should be created.',
        },
        content: {
          type: 'string',
          description: 'Content to write into the file.',
        },
        overwrite: {
          type: 'boolean',
          description: 'If true, existing files will be overwritten. Default is false.',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'edit_file',
    description: 'Safely edit a file by finding exact old_text and replacing it with new_text. Fails safely without modifying the file if old_text is not found.',
    category: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path to the file to edit.',
        },
        old_text: {
          type: 'string',
          description: 'Exact text segment currently in the file to be replaced.',
        },
        new_text: {
          type: 'string',
          description: 'New text segment to replace old_text with.',
        },
        replace_all: {
          type: 'boolean',
          description: 'If true, replaces all occurrences of old_text instead of just the first. Default is false.',
        },
      },
      required: ['path', 'old_text', 'new_text'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file or directory inside the workspace. Directory deletion requires recursive: true.',
    category: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Relative path of the file or directory to delete.',
        },
        recursive: {
          type: 'boolean',
          description: 'Set to true when deleting a non-empty directory.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'move_file',
    description: 'Move or rename a file or directory within the workspace.',
    category: 'write',
    inputSchema: {
      type: 'object',
      properties: {
        source_path: {
          type: 'string',
          description: 'Current relative path of the file or directory.',
        },
        destination_path: {
          type: 'string',
          description: 'Target relative path in the workspace.',
        },
        overwrite: {
          type: 'boolean',
          description: 'Whether to overwrite destination if it exists. Default is false.',
        },
      },
      required: ['source_path', 'destination_path'],
    },
  },
  {
    name: 'run_command',
    description: 'Execute a shell command inside the workspace working directory. Returns stdout, stderr, exit code, and execution duration.',
    category: 'execute',
    inputSchema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'Shell command line to execute inside the project root.',
        },
        timeout_ms: {
          type: 'integer',
          description: 'Maximum duration in milliseconds to allow the command to run. Default is 30000 (30 seconds).',
        },
      },
      required: ['command'],
    },
  },
];

export class McpServer {
  private sandbox: WorkspaceSandbox;
  private permissionManager: PermissionManager;
  private logger: StructuredActivityLogger;

  constructor(
    sandbox: WorkspaceSandbox,
    permissionManager: PermissionManager,
    logger: StructuredActivityLogger
  ) {
    this.sandbox = sandbox;
    this.permissionManager = permissionManager;
    this.logger = logger;
  }

  public updateSandbox(newSandbox: WorkspaceSandbox): void {
    this.sandbox = newSandbox;
  }

  /**
   * Main JSON-RPC request dispatcher.
   */
  public async handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const { id = null, method, params } = request;

    this.logger.debug('mcp_request', `Handling MCP method: ${method}`, { method, id });

    try {
      switch (method) {
        case 'initialize':
          return this.handleInitialize(id, params);

        case 'notifications/initialized':
          this.logger.info('session', 'MCP Client session initialized');
          return { jsonrpc: '2.0', id, result: {} };

        case 'ping':
          return { jsonrpc: '2.0', id, result: {} };

        case 'tools/list':
          return this.handleToolsList(id);

        case 'tools/call':
          return await this.handleToolCall(id, params);

        default:
          this.logger.warn('mcp_request', `Method not found: ${method}`);
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32601,
              message: `Method not found: ${method}`,
            },
          };
      }
    } catch (err: any) {
      this.logger.error('server', `Internal error handling ${method}: ${err.message}`);
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: `Internal server error: ${err.message}`,
        },
      };
    }
  }

  private handleInitialize(id: string | number | null, params?: any): JsonRpcResponse {
    const clientName = params?.clientInfo?.name || 'Unknown Client';
    const clientVersion = params?.clientInfo?.version || '1.0';

    this.logger.info('session', `Client connected: ${clientName} v${clientVersion}`, {
      protocolVersion: params?.protocolVersion,
      clientInfo: params?.clientInfo,
    });

    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {
            listChanged: false,
          },
          logging: {},
        },
        serverInfo: {
          name: 'vibebridge',
          version: '0.1.0',
        },
      },
    };
  }

  private handleToolsList(id: string | number | null): JsonRpcResponse {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: VIBEBRIDGE_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      },
    };
  }

  private async handleToolCall(id: string | number | null, params?: any): Promise<JsonRpcResponse> {
    const toolName = params?.name as ToolName;
    const args = params?.arguments || {};

    if (!toolName) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32602,
          message: 'Missing tool name in tools/call request',
        },
      };
    }

    const toolDef = VIBEBRIDGE_TOOLS.find((t) => t.name === toolName);
    if (!toolDef) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: `Tool not found: ${toolName}`,
        },
      };
    }

    this.logger.info('tool_call', `Tool invocation: ${toolName}`, { tool: toolName, arguments: args });

    try {
      let resultData: any;

      switch (toolName) {
        case 'list_files': {
          const validated = ListFilesSchema.parse(args);
          resultData = await listFiles(this.sandbox, validated);
          this.logger.info('file_op', `list_files: ${resultData.totalFiles} items in '${validated.path || '.'}'`);
          break;
        }

        case 'read_file': {
          const validated = ReadFileSchema.parse(args);
          resultData = await readFile(this.sandbox, validated);
          this.logger.info('file_op', `read_file: read ${resultData.lines} lines from '${validated.path}'`);
          break;
        }

        case 'search_files': {
          const validated = SearchFilesSchema.parse(args);
          resultData = await searchFiles(this.sandbox, validated);
          this.logger.info('file_op', `search_files: ${resultData.totalMatches} matches for '${validated.query}'`);
          break;
        }

        case 'create_file': {
          const validated = CreateFileSchema.parse(args);
          // Check permission
          await this.permissionManager.authorize(
            'create_file',
            validated.path,
            this.sandbox.getCanonicalPath(),
            { sizeBytes: Buffer.byteLength(validated.content), overwrite: validated.overwrite }
          );
          resultData = await createFile(this.sandbox, validated);
          this.logger.info('file_op', `create_file: created '${validated.path}' (${resultData.bytesWritten} bytes)`);
          break;
        }

        case 'edit_file': {
          const validated = EditFileSchema.parse(args);
          // Check permission
          await this.permissionManager.authorize(
            'edit_file',
            validated.path,
            this.sandbox.getCanonicalPath(),
            { oldTextPreview: validated.old_text.slice(0, 100), replaceAll: validated.replace_all }
          );
          resultData = await editFile(this.sandbox, validated);
          this.logger.info('file_op', `edit_file: modified '${validated.path}' (${resultData.replacements} replacements)`);
          break;
        }

        case 'delete_file': {
          const validated = DeleteFileSchema.parse(args);
          // Check permission
          await this.permissionManager.authorize(
            'delete_file',
            validated.path,
            this.sandbox.getCanonicalPath(),
            { recursive: validated.recursive }
          );
          resultData = await deleteFile(this.sandbox, validated);
          this.logger.info('file_op', `delete_file: deleted '${validated.path}'`);
          break;
        }

        case 'move_file': {
          const validated = MoveFileSchema.parse(args);
          // Check permission
          await this.permissionManager.authorize(
            'move_file',
            `${validated.source_path} -> ${validated.destination_path}`,
            this.sandbox.getCanonicalPath(),
            { overwrite: validated.overwrite }
          );
          resultData = await moveFile(this.sandbox, validated);
          this.logger.info('file_op', `move_file: moved '${validated.source_path}' to '${validated.destination_path}'`);
          break;
        }

        case 'run_command': {
          const validated = RunCommandSchema.parse(args);
          // Check permission
          await this.permissionManager.authorize(
            'run_command',
            validated.command,
            this.sandbox.getCanonicalPath(),
            { timeoutMs: validated.timeout_ms }
          );
          resultData = await runCommand(this.sandbox, validated);
          this.logger.info(
            'command_exec',
            `run_command: '${validated.command}' exited with code ${resultData.exitCode} (${resultData.durationMs}ms)`
          );
          break;
        }
      }

      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(resultData, null, 2),
            },
          ],
          isError: false,
        },
      };
    } catch (err: any) {
      this.logger.error('tool_call', `Tool '${toolName}' failed: ${err.message}`, {
        error: err.name,
        code: err.code,
      });

      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: `Error executing tool '${toolName}': ${err.message}`,
            },
          ],
          isError: true,
        },
      };
    }
  }
}
