import React, { useState } from 'react';
import { BridgeStatus, PermissionMode } from '../types';
import { StatusBadge } from './StatusBadge';

interface SidebarProps {
  status: BridgeStatus;
  onStart: () => void;
  onStop: () => void;
  onWorkspaceChange: (path: string) => void;
  onPermissionModeChange: (mode: PermissionMode) => void;
  pendingPermissionsCount: number;
}

export const Sidebar: React.FC<SidebarProps> = ({
  status,
  onStart,
  onStop,
  onWorkspaceChange,
  onPermissionModeChange,
  pendingPermissionsCount,
}) => {
  const [copied, setCopied] = useState(false);
  const [isEditingPath, setIsEditingPath] = useState(false);
  const [tempPath, setTempPath] = useState(status.workspacePath);

  const projectName = status.workspacePath
    ? status.workspacePath.split(/[/\\]/).filter(Boolean).pop() || 'Workspace'
    : 'No Project Selected';

  const mcpUrl = status.mcpEndpoint || (status.localUrl ? `${status.localUrl}` : 'Server not running');

  const handleCopy = () => {
    if (status.mcpEndpoint || status.localUrl) {
      navigator.clipboard.writeText(status.mcpEndpoint || status.localUrl || '');
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleSavePath = () => {
    if (tempPath.trim()) {
      onWorkspaceChange(tempPath.trim());
      setIsEditingPath(false);
    }
  };

  return (
    <aside className="sidebar">
      {/* Brand Header */}
      <div className="brand">
        <div className="brand-icon">V</div>
        <div>
          <h1 className="brand-title">VibeBridge</h1>
          <p className="brand-subtitle">Gemini Spark Execution Layer</p>
        </div>
      </div>

      {/* Connection Status */}
      <div className="sidebar-section">
        <div className="section-label">Bridge Status</div>
        <div className="status-row">
          <StatusBadge status={status.serverStatus} pendingPermissions={pendingPermissionsCount} />
          <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Sessions: {status.activeSessions}
          </span>
        </div>
      </div>

      {/* Project / Workspace Selection */}
      <div className="sidebar-section">
        <div className="section-label">Selected Project</div>
        <div className="workspace-card">
          <div className="workspace-name">{projectName}</div>
          {isEditingPath ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '4px' }}>
              <input
                type="text"
                value={tempPath}
                onChange={(e) => setTempPath(e.target.value)}
                placeholder="/path/to/project"
                style={{
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--border-color)',
                  color: 'var(--text-primary)',
                  padding: '6px 8px',
                  borderRadius: '4px',
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                }}
              />
              <div style={{ display: 'flex', gap: '4px' }}>
                <button className="btn-small" onClick={handleSavePath} style={{ flex: 1, color: 'var(--accent-green)' }}>
                  Set Path
                </button>
                <button className="btn-small" onClick={() => setIsEditingPath(false)} style={{ flex: 1 }}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="workspace-path" title={status.workspacePath}>
                {status.workspacePath || 'None'}
              </div>
              <button
                className="btn-small"
                onClick={() => {
                  setTempPath(status.workspacePath);
                  setIsEditingPath(true);
                }}
              >
                Change Workspace Directory
              </button>
            </>
          )}
        </div>
      </div>

      {/* MCP Endpoint Card */}
      <div className="sidebar-section">
        <div className="section-label">MCP Endpoint for Gemini Spark</div>
        <div className="mcp-url-card">
          <div className="url-box">
            <span className="url-text" title={mcpUrl}>
              {mcpUrl}
            </span>
            <button
              className="btn-copy"
              onClick={handleCopy}
              disabled={status.serverStatus !== 'running'}
              title="Copy to clipboard"
            >
              {copied ? '✓ Copied' : 'Copy'}
            </button>
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            {status.publicUrl ? (
              <span style={{ color: 'var(--accent-green)' }}>● Public HTTPS Tunnel Active</span>
            ) : status.serverStatus === 'running' ? (
              <span style={{ color: 'var(--accent-amber)' }}>● Localhost Only (No Public Tunnel)</span>
            ) : (
              'Start bridge to generate endpoint'
            )}
          </div>
        </div>
      </div>

      {/* Permission Mode Configuration */}
      <div className="sidebar-section">
        <div className="section-label">Permission Policy</div>
        <select
          className="input-select"
          value={status.permissionMode}
          onChange={(e) => onPermissionModeChange(e.target.value as PermissionMode)}
        >
          <option value="prompt">Prompt for Writes & Execution</option>
          <option value="auto_approve_read">Auto-Approve Reads Only</option>
          <option value="auto_approve_all">Auto-Approve All (Developer)</option>
          <option value="deny_writes">Strict Read-Only Mode</option>
        </select>
        <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
          Controls whether write tools and terminal runs require interactive confirmation.
        </span>
      </div>

      {/* Controls */}
      <div style={{ marginTop: 'auto' }}>
        {status.serverStatus === 'running' ? (
          <button className="btn-action btn-stop" onClick={onStop}>
            Stop VibeBridge
          </button>
        ) : (
          <button
            className="btn-action btn-start"
            onClick={onStart}
            disabled={status.serverStatus === 'starting' || !status.workspacePath}
          >
            {status.serverStatus === 'starting' ? 'Starting...' : 'Start VibeBridge'}
          </button>
        )}
      </div>
    </aside>
  );
};
