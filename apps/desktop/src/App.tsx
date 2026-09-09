import React, { useState, useEffect } from 'react';
import { Sidebar } from './components/Sidebar';
import { ActivityLog } from './components/ActivityLog';
import { PermissionModal } from './components/PermissionModal';
import { ToolCallViewer } from './components/ToolCallViewer';
import { BridgeStatus, ActivityLogItem, PermissionRequest, ActiveTab, PermissionMode } from './types';

export const App: React.FC = () => {
  const [status, setStatus] = useState<BridgeStatus>({
    serverStatus: 'stopped',
    tunnelStatus: 'disconnected',
    localUrl: null,
    publicUrl: null,
    mcpEndpoint: null,
    workspacePath: '/home/user/projects/my-app',
    activeSessions: 0,
    permissionMode: 'prompt',
  });

  const [logs, setLogs] = useState<ActivityLogItem[]>([]);
  const [pendingPermissions, setPendingPermissions] = useState<PermissionRequest[]>([]);
  const [activeTab, setActiveTab] = useState<ActiveTab>('all');
  const [viewMode, setViewMode] = useState<'feed' | 'inspector'>('feed');

  // Handle runtime start
  const handleStart = async () => {
    setStatus((prev) => ({ ...prev, serverStatus: 'starting' }));

    // Simulating runtime initialization or calling Tauri / HTTP endpoint
    setTimeout(() => {
      const localUrl = 'http://127.0.0.1:3000/mcp';
      const publicUrl = 'https://vibebridge-demo.ngrok-free.app';
      const mcpEndpoint = `${publicUrl}/mcp`;

      setStatus((prev) => ({
        ...prev,
        serverStatus: 'running',
        tunnelStatus: 'connected',
        localUrl,
        publicUrl,
        mcpEndpoint,
      }));

      addLog('info', 'server', `VibeBridge MCP server started on ${localUrl}`);
      addLog('info', 'tunnel', `Public HTTPS tunnel established at ${mcpEndpoint}`);
    }, 800);
  };

  // Handle runtime stop
  const handleStop = async () => {
    setStatus((prev) => ({
      ...prev,
      serverStatus: 'stopped',
      tunnelStatus: 'disconnected',
      localUrl: null,
      publicUrl: null,
      mcpEndpoint: null,
      activeSessions: 0,
    }));
    setPendingPermissions([]);
    addLog('info', 'server', 'VibeBridge stopped by user.');
  };

  const handleWorkspaceChange = (newPath: string) => {
    setStatus((prev) => ({ ...prev, workspacePath: newPath }));
    addLog('info', 'server', `Workspace path updated to: ${newPath}`);
  };

  const handlePermissionModeChange = (mode: PermissionMode) => {
    setStatus((prev) => ({ ...prev, permissionMode: mode }));
    addLog('info', 'permission', `Permission policy set to: ${mode}`);
  };

  const handleAllowPermission = (id: string) => {
    const req = pendingPermissions.find((p) => p.id === id);
    if (req) {
      addLog('info', 'permission', `User APPROVED operation: ${req.operation} on '${req.target}'`, req);
    }
    setPendingPermissions((prev) => prev.filter((p) => p.id !== id));
  };

  const handleDenyPermission = (id: string) => {
    const req = pendingPermissions.find((p) => p.id === id);
    if (req) {
      addLog('warn', 'permission', `User DENIED operation: ${req.operation} on '${req.target}'`, req);
    }
    setPendingPermissions((prev) => prev.filter((p) => p.id !== id));
  };

  const addLog = (
    level: ActivityLogItem['level'],
    category: ActivityLogItem['category'],
    message: string,
    metadata?: Record<string, any>
  ) => {
    const newLog: ActivityLogItem = {
      id: Math.random().toString(36).substring(2),
      timestamp: new Date().toISOString(),
      level,
      category,
      message,
      metadata,
    };
    setLogs((prev) => [...prev, newLog]);
  };

  return (
    <div className="app-container">
      {/* Sidebar */}
      <Sidebar
        status={status}
        onStart={handleStart}
        onStop={handleStop}
        onWorkspaceChange={handleWorkspaceChange}
        onPermissionModeChange={handlePermissionModeChange}
        pendingPermissionsCount={pendingPermissions.length}
      />

      {/* Main Workspace Area */}
      <main className="main-area">
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)', background: 'var(--bg-secondary)', padding: '0 24px' }}>
          <button
            className={`tab-btn ${viewMode === 'feed' ? 'active' : ''}`}
            style={{ padding: '12px 16px', borderRadius: 0, borderBottom: viewMode === 'feed' ? '2px solid var(--accent-blue)' : 'none' }}
            onClick={() => setViewMode('feed')}
          >
            Live Activity Feed
          </button>
          <button
            className={`tab-btn ${viewMode === 'inspector' ? 'active' : ''}`}
            style={{ padding: '12px 16px', borderRadius: 0, borderBottom: viewMode === 'inspector' ? '2px solid var(--accent-blue)' : 'none' }}
            onClick={() => setViewMode('inspector')}
          >
            Tool Call Inspector
          </button>
        </div>

        <div style={{ flex: 1, overflow: 'hidden' }}>
          {viewMode === 'feed' ? (
            <ActivityLog
              logs={logs}
              activeTab={activeTab}
              onTabChange={setActiveTab}
              onClear={() => setLogs([])}
            />
          ) : (
            <div style={{ padding: '20px 24px', height: '100%', boxSizing: 'border-box' }}>
              <ToolCallViewer logs={logs} />
            </div>
          )}
        </div>
      </main>

      {/* Permission Request Modal */}
      {pendingPermissions.length > 0 && (
        <PermissionModal
          request={pendingPermissions[0]}
          onAllow={handleAllowPermission}
          onDeny={handleDenyPermission}
        />
      )}
    </div>
  );
};

export default App;
