import React, { useState } from 'react';
import { ActivityLogItem } from '../types';

interface ToolCallViewerProps {
  logs: ActivityLogItem[];
}

export const ToolCallViewer: React.FC<ToolCallViewerProps> = ({ logs }) => {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const toolLogs = logs.filter(
    (l) => l.category === 'tool_call' || l.category === 'command_exec' || l.category === 'file_op'
  );

  const selectedLog = toolLogs.find((l) => l.id === selectedId) || toolLogs[0];

  return (
    <div style={{ display: 'flex', height: '100%', gap: '16px' }}>
      {/* Tool Call History List */}
      <div
        style={{
          width: '280px',
          borderRight: '1px solid var(--border-color)',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: '8px',
          paddingRight: '12px',
        }}
      >
        <div className="section-label" style={{ marginBottom: '8px' }}>
          Recent Tool Calls ({toolLogs.length})
        </div>

        {toolLogs.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', fontSize: '12px' }}>No tool calls yet.</div>
        ) : (
          toolLogs.map((log) => {
            const isSelected = selectedLog?.id === log.id;
            return (
              <div
                key={log.id}
                onClick={() => setSelectedId(log.id)}
                style={{
                  padding: '8px 10px',
                  borderRadius: '6px',
                  background: isSelected ? 'var(--bg-tertiary)' : 'var(--bg-card)',
                  border: isSelected ? '1px solid var(--accent-blue)' : '1px solid var(--border-color)',
                  cursor: 'pointer',
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>
                    {log.metadata?.tool || log.category}
                  </span>
                  <span style={{ color: 'var(--text-muted)' }}>
                    {new Date(log.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: '11px',
                    color: 'var(--text-secondary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    marginTop: '2px',
                  }}
                >
                  {log.message}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Inspector Panel */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '12px', overflowY: 'auto' }}>
        {selectedLog ? (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <h3 style={{ fontSize: '15px', fontWeight: 600 }}>{selectedLog.message}</h3>
              <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                {new Date(selectedLog.timestamp).toLocaleString()}
              </span>
            </div>

            {selectedLog.metadata && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <span className="section-label">Inspection Payload & Results</span>
                <pre
                  style={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border-color)',
                    padding: '12px',
                    borderRadius: '8px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: '12px',
                    color: 'var(--text-primary)',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    maxHeight: '400px',
                    overflowY: 'auto',
                  }}
                >
                  {JSON.stringify(selectedLog.metadata, null, 2)}
                </pre>
              </div>
            )}
          </>
        ) : (
          <div style={{ color: 'var(--text-muted)', textAlign: 'center', marginTop: '40px' }}>
            Select a tool call on the left to inspect its inputs and outputs.
          </div>
        )}
      </div>
    </div>
  );
};
