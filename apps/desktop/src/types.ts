import {
  BridgeStatus,
  ActivityLogItem,
  PermissionRequest,
  PermissionMode,
} from '@vibebridge/shared';

export type { BridgeStatus, ActivityLogItem, PermissionRequest, PermissionMode };

export type ActiveTab = 'all' | 'tool_call' | 'file_op' | 'command_exec' | 'mcp_request' | 'permission' | 'error';
