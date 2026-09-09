import React from 'react';
import { PermissionRequest } from '../types';

interface PermissionModalProps {
  request: PermissionRequest;
  onAllow: (id: string) => void;
  onDeny: (id: string) => void;
}

export const PermissionModal: React.FC<PermissionModalProps> = ({
  request,
  onAllow,
  onDeny,
}) => {
  const isCommand = request.operation === 'run_command';

  return (
    <div className="modal-overlay">
      <div className="modal-card">
        {/* Header */}
        <div className="modal-header">
          <span style={{ fontSize: '20px' }}>⚠️</span>
          <div>
            <div className="modal-title">Security Authorization Required</div>
            <div style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Gemini Spark is requesting authorization to perform a sensitive operation.
            </div>
          </div>
        </div>

        {/* Content Body */}
        <div className="modal-body">
          <div className="perm-row">
            <span className="perm-label">Operation</span>
            <span className="perm-val" style={{ color: isCommand ? 'var(--accent-purple)' : 'var(--accent-amber)' }}>
              {request.operation.toUpperCase()} ({request.category.toUpperCase()})
            </span>
          </div>

          <div className="perm-row">
            <span className="perm-label">{isCommand ? 'Shell Command' : 'Target File / Path'}</span>
            <span className="perm-val" style={{ fontWeight: 600 }}>
              {request.target}
            </span>
          </div>

          <div className="perm-row">
            <span className="perm-label">Working Directory</span>
            <span className="perm-val" style={{ fontSize: '11px' }}>
              {request.workingDirectory}
            </span>
          </div>

          {request.details && (
            <div className="perm-row">
              <span className="perm-label">Operation Parameters</span>
              <pre
                className="perm-val"
                style={{
                  fontSize: '11px',
                  maxHeight: '120px',
                  overflowY: 'auto',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {JSON.stringify(request.details, null, 2)}
              </pre>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="modal-footer">
          <button className="btn-deny" onClick={() => onDeny(request.id)}>
            Deny Operation
          </button>
          <button className="btn-allow" onClick={() => onAllow(request.id)}>
            Allow Operation
          </button>
        </div>
      </div>
    </div>
  );
};
