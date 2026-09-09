import React from 'react';

interface StatusBadgeProps {
  status: 'running' | 'stopped' | 'starting' | 'error';
  pendingPermissions?: number;
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, pendingPermissions = 0 }) => {
  if (pendingPermissions > 0) {
    return (
      <span className="status-pill status-warning">
        <span className="status-dot" />
        Approval Needed ({pendingPermissions})
      </span>
    );
  }

  switch (status) {
    case 'running':
      return (
        <span className="status-pill status-running">
          <span className="status-dot" />
          Active
        </span>
      );
    case 'starting':
      return (
        <span className="status-pill status-warning">
          <span className="status-dot" />
          Starting...
        </span>
      );
    case 'error':
      return (
        <span className="status-pill status-stopped" style={{ color: '#ef4444' }}>
          <span className="status-dot" style={{ background: '#ef4444' }} />
          Error
        </span>
      );
    default:
      return (
        <span className="status-pill status-stopped">
          <span className="status-dot" />
          Stopped
        </span>
      );
  }
};
