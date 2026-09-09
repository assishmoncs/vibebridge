import React, { useState } from 'react';
import { ActivityLogItem, ActiveTab } from '../types';

interface ActivityLogProps {
  logs: ActivityLogItem[];
  activeTab: ActiveTab;
  onTabChange: (tab: ActiveTab) => void;
  onClear: () => void;
}

export const ActivityLog: React.FC<ActivityLogProps> = ({
  logs,
  activeTab,
  onTabChange,
  onClear,
}) => {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filteredLogs = logs.filter((log) => {
    if (activeTab === 'all') return true;
    if (activeTab === 'error') return log.level === 'error';
    return log.category === activeTab;
  });

  const getBadgeClass = (level: string) => {
    switch (level) {
      case 'error': return 'badge-error';
      case 'warn': return 'badge-warn';
      case 'debug': return 'badge-debug';
      default: return 'badge-info';
    }
  };

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Header and Filter Tabs */}
      <header className="main-header">
        <div className="header-title-group">
          <h2 className="header-title">Bridge Activity Feed</h2>
          <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>
            ({filteredLogs.length} events)
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <nav className="tab-nav">
            <button
              className={`tab-btn ${activeTab === 'all' ? 'active' : ''}`}
              onClick={() => onTabChange('all')}
            >
              All
            </button>
            <button
              className={`tab-btn ${activeTab === 'tool_call' ? 'active' : ''}`}
              onClick={() => onTabChange('tool_call')}
            >
              Tool Calls
            </button>
            <button
              className={`tab-btn ${activeTab === 'file_op' ? 'active' : ''}`}
              onClick={() => onTabChange('file_op')}
            >
              Filesystem
            </button>
            <button
              className={`tab-btn ${activeTab === 'command_exec' ? 'active' : ''}`}
              onClick={() => onTabChange('command_exec')}
            >
              Terminal
            </button>
            <button
              className={`tab-btn ${activeTab === 'permission' ? 'active' : ''}`}
              onClick={() => onTabChange('permission')}
            >
              Permissions
            </button>
            <button
              className={`tab-btn ${activeTab === 'error' ? 'active' : ''}`}
              onClick={() => onTabChange('error')}
            >
              Errors
            </button>
          </nav>

          <button className="btn-small" onClick={onClear} title="Clear activity log">
            Clear
          </button>
        </div>
      </header>

      {/* Log Feed */}
      <div className="content-body">
        {filteredLogs.length === 0 ? (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', marginTop: '60px' }}>
            <p style={{ fontSize: '15px', fontWeight: 500 }}>No activity events recorded yet.</p>
            <p style={{ fontSize: '13px', marginTop: '6px' }}>
              Connect Gemini Spark to the MCP Endpoint to start receiving workspace tool calls.
            </p>
          </div>
        ) : (
          filteredLogs.map((log) => {
            const isExpanded = expandedId === log.id;
            const timeStr = new Date(log.timestamp).toLocaleTimeString();

            return (
              <div
                key={log.id}
                className="log-item"
                onClick={() => log.metadata && toggleExpand(log.id)}
                style={{ cursor: log.metadata ? 'pointer' : 'default' }}
              >
                <div className="log-header">
                  <span className="log-time">{timeStr}</span>
                  <span className={`log-badge ${getBadgeClass(log.level)}`}>{log.level}</span>
                  <span className="log-category">[{log.category}]</span>
                  {log.metadata && (
                    <span style={{ fontSize: '10px', color: 'var(--text-muted)', marginLeft: 'auto' }}>
                      {isExpanded ? '▲ Hide Details' : '▼ Inspect Details'}
                    </span>
                  )}
                </div>

                <div className="log-message">{log.message}</div>

                {isExpanded && log.metadata && (
                  <div className="log-meta">
                    {JSON.stringify(log.metadata, null, 2)}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
