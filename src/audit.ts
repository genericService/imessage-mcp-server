import fs from 'fs';
import path from 'path';

export interface AuditEvent {
  timestamp: string;
  tool: string;
  target?: string;
  dry_run?: boolean;
  status: 'success' | 'error';
  duration_ms: number;
  error_message?: string;
}

const LOG_DIR = path.resolve(process.cwd(), 'logs');
const AUDIT_FILE = path.join(LOG_DIR, 'audit.log');

/**
 * Opt-in Local Security Audit Trail logger.
 * Never logs actual message text, passwords, or attachment payloads.
 */
export function logAuditEvent(event: AuditEvent): void {
  if (process.env.ENABLE_AUDIT_LOG !== 'true') {
    return;
  }

  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }

    const logLine = JSON.stringify(event) + '\n';
    fs.appendFileSync(AUDIT_FILE, logLine, 'utf8');
  } catch (err) {
    console.error('[Audit Logger Error] Failed to write audit event:', err);
  }
}
