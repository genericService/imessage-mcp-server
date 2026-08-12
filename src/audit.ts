import fs from 'fs';
import path from 'path';
import { config, PACKAGE_ROOT } from './config.js';

export interface AuditEvent {
  timestamp: string;
  type?: 'tool_call' | 'http_connection';
  client_id?: string;
  client_ip?: string;
  user_agent?: string;
  method?: string;
  path?: string;
  status_code?: number;
  tool?: string;
  target?: string;
  dry_run?: boolean;
  status: 'success' | 'error';
  duration_ms: number;
  error_message?: string;
  error_code?: string;
}

/**
 * Resolve the log directory against the package root rather than
 * `process.cwd()`. The previous cwd-relative path meant logs landed in a
 * different place (or an unwritable one) depending on how the server was
 * launched -- systemd/launchd units commonly start with cwd `/`.
 */
const LOG_DIR = process.env.LOG_DIR
  ? path.resolve(process.env.LOG_DIR)
  : path.join(PACKAGE_ROOT, 'logs');
const AUDIT_FILE = path.join(LOG_DIR, 'audit.log');

let writeStream: fs.WriteStream | null = null;
let bytesWritten = 0;
/** Latches on unrecoverable IO failure so we degrade instead of log-spamming. */
let disabled = false;
let disabledReason = '';

export function getAuditStatus() {
  return {
    enabled: config.enableAuditLog && !disabled,
    file: config.enableAuditLog ? AUDIT_FILE : null,
    degraded: disabled,
    reason: disabledReason || undefined
  };
}

function openStream(): fs.WriteStream | null {
  if (disabled) return null;
  if (writeStream) return writeStream;

  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    bytesWritten = fs.existsSync(AUDIT_FILE) ? fs.statSync(AUDIT_FILE).size : 0;

    const stream = fs.createWriteStream(AUDIT_FILE, { flags: 'a' });
    // Without an 'error' handler a stream error is an unhandled 'error' event,
    // which takes the whole process down. Audit logging must never do that.
    stream.on('error', (err) => {
      disabled = true;
      disabledReason = err.message;
      writeStream = null;
      console.error('[Audit] Disabling audit log after write error:', err.message);
    });
    writeStream = stream;
    return stream;
  } catch (err: any) {
    disabled = true;
    disabledReason = err?.message || String(err);
    console.error('[Audit] Could not open audit log; continuing without it:', disabledReason);
    return null;
  }
}

/** Size-based rotation so an unattended server cannot fill its disk. */
function rotateIfNeeded(): void {
  if (bytesWritten < config.auditMaxBytes) return;

  try {
    writeStream?.end();
    writeStream = null;

    const oldest = `${AUDIT_FILE}.${config.auditMaxFiles}`;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);

    for (let i = config.auditMaxFiles - 1; i >= 1; i--) {
      const src = `${AUDIT_FILE}.${i}`;
      if (fs.existsSync(src)) fs.renameSync(src, `${AUDIT_FILE}.${i + 1}`);
    }
    if (fs.existsSync(AUDIT_FILE)) fs.renameSync(AUDIT_FILE, `${AUDIT_FILE}.1`);
    bytesWritten = 0;
  } catch (err: any) {
    console.error('[Audit] Log rotation failed:', err?.message || err);
  }
}

/** Defence in depth: never let message bodies reach disk. */
const FORBIDDEN_KEYS = new Set(['message', 'message_text', 'text', 'body', 'base64', 'attachment_payload', 'password', 'token', 'secret']);

function sanitise(event: AuditEvent): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (value === undefined) continue;
    out[key] = typeof value === 'string' && value.length > 512 ? `${value.slice(0, 512)}...` : value;
  }
  return out;
}

/**
 * Opt-in local security audit trail.
 *
 * Writes asynchronously through a persistent append stream. The previous
 * implementation used `fs.appendFileSync` on every event, which blocked the
 * event loop on each request and, on a slow or full disk, stalled the server.
 * Never logs message text, passwords or attachment payloads.
 */
export function logAuditEvent(event: AuditEvent): void {
  if (!config.enableAuditLog && process.env.ENABLE_AUDIT_LOG !== 'true') {
    return;
  }
  if (disabled) return;

  try {
    const stream = openStream();
    if (!stream) return;

    const line = `${JSON.stringify(sanitise(event))}\n`;
    bytesWritten += Buffer.byteLength(line);
    stream.write(line);
    rotateIfNeeded();
  } catch (err: any) {
    console.error('[Audit Logger Error] Failed to write audit event:', err?.message || err);
  }
}

/** Flush and close the audit stream during graceful shutdown. */
export async function closeAuditLog(): Promise<void> {
  const stream = writeStream;
  if (!stream) return;
  writeStream = null;
  await new Promise<void>((resolve) => stream.end(resolve));
}
