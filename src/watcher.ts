import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import { runImessageCli } from './index.js';

export type WatchEventType = 'message_in' | 'message_out' | 'reaction' | 'read_receipt' | 'delivered';

export interface WatchRule {
  webhook_url: string;
  chats: (string | number)[];
  events?: WatchEventType[];
  debounce_ms?: number;
  secret?: string;
}

export interface WatcherConfig {
  enabled?: boolean;
  poll_interval_ms?: number;
  state_file?: string;
  rules: WatchRule[];
}

export interface WatchState {
  version: number;
  last_seen_msg_id: number;
  receipt_state: Record<string, { delivered: boolean; read: boolean }>;
  updated_at_iso: string;
}

export interface WebhookPayload {
  event: WatchEventType;
  chat_id: number;
  newest_msg_id: number;
  count: number;
  since_msg_id_hint: number;
  occurred_at_iso: string;
}

export interface RawDetectedMessage {
  msg_id: number;
  guid: string;
  chat_id: number;
  chat_identifiers: string[];
  event: WatchEventType;
  is_from_me: boolean;
  occurred_at_iso: string;
}

export interface RawReceiptEvent {
  event: WatchEventType;
  chat_id: number;
  chat_identifiers: string[];
  msg_id: number;
  occurred_at_iso: string;
}

export interface ChangesCliResult {
  max_msg_id: number;
  new_messages: RawDetectedMessage[];
  receipt_events: RawReceiptEvent[];
  receipt_state: Record<string, { delivered: boolean; read: boolean }>;
}

export interface PendingDispatch {
  ruleIndex: number;
  rule: WatchRule;
  event: WatchEventType;
  chat_id: number;
  newest_msg_id: number;
  count: number;
  since_msg_id_hint: number;
  occurred_at_iso: string;
  timer: NodeJS.Timeout;
}

export interface ResourceNotificationTarget {
  sendResourceUpdated(params: { uri: string }): Promise<void>;
}

export function normalizeIdentifier(val: string | number): string {
  const str = String(val).trim();
  const clean = str.replace(/[^a-zA-Z0-9@]/g, '').toLowerCase();
  if (clean.length === 11 && clean.startsWith('1') && /^\d+$/.test(clean)) {
    return clean.slice(1);
  }
  return clean;
}

export function ruleMatchesEvent(
  rule: WatchRule,
  event: WatchEventType,
  chatId: number,
  chatIdentifiers: string[]
): boolean {
  const allowedEvents = rule.events && rule.events.length > 0
    ? rule.events
    : (['message_in', 'reaction'] as WatchEventType[]);

  if (!allowedEvents.includes(event)) {
    return false;
  }

  if (!Array.isArray(rule.chats) || rule.chats.length === 0) {
    return false;
  }

  const normalizedEventTargets = new Set<string>();
  normalizedEventTargets.add(String(chatId));
  for (const ident of chatIdentifiers) {
    normalizedEventTargets.add(String(ident));
    const norm = normalizeIdentifier(ident);
    if (norm) {
      normalizedEventTargets.add(norm);
    }
  }

  for (const target of rule.chats) {
    const rawTarget = String(target).trim();
    const normTarget = normalizeIdentifier(target);
    if (normalizedEventTargets.has(rawTarget) || (normTarget && normalizedEventTargets.has(normTarget))) {
      return true;
    }
  }

  return false;
}

export function computeHmacSignature(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

export async function deliverWebhook(
  url: string,
  payload: WebhookPayload,
  secret?: string,
  maxRetries = 3
): Promise<boolean> {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'imessage-mcp-server/1.4.0',
  };

  if (secret) {
    const signature = computeHmacSignature(body, secret);
    headers['X-Signature-SHA256'] = `sha256=${signature}`;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(5000),
      });

      if (response.ok) {
        return true;
      }

      console.warn(`[Watcher] Webhook returned status ${response.status} for ${url} (attempt ${attempt + 1}/${maxRetries + 1})`);
    } catch (err: any) {
      console.warn(`[Watcher] Webhook delivery failed for ${url} (attempt ${attempt + 1}/${maxRetries + 1}): ${err?.message || err}`);
    }

    if (attempt < maxRetries) {
      const backoffMs = Math.min(1000 * Math.pow(2, attempt), 8000);
      await new Promise((res) => setTimeout(res, backoffMs));
    }
  }

  return false;
}

export function parseWatcherConfig(): WatcherConfig | null {
  const isEnabled = process.env.WATCH_ENABLED === 'true';

  let rawRules: any = null;
  const envRules = process.env.WATCH_RULES;
  const configFile = process.env.WATCH_CONFIG_FILE || path.join(os.homedir(), '.imessage-mcp', 'watch-config.json');

  if (envRules && envRules.trim()) {
    try {
      rawRules = JSON.parse(envRules);
    } catch (err: any) {
      console.error(`[Watcher] Invalid JSON in WATCH_RULES: ${err.message}`);
    }
  } else if (fs.existsSync(configFile)) {
    try {
      const content = fs.readFileSync(configFile, 'utf8');
      rawRules = JSON.parse(content);
    } catch (err: any) {
      console.error(`[Watcher] Failed reading config file ${configFile}: ${err.message}`);
    }
  }

  let rulesList: WatchRule[] = [];
  if (Array.isArray(rawRules)) {
    rulesList = rawRules;
  } else if (rawRules && typeof rawRules === 'object' && Array.isArray(rawRules.rules)) {
    rulesList = rawRules.rules;
  }

  const validRules: WatchRule[] = [];
  for (const r of rulesList) {
    if (!r.webhook_url || typeof r.webhook_url !== 'string') {
      console.warn('[Watcher] Skipping rule with missing webhook_url');
      continue;
    }
    if (!Array.isArray(r.chats) || r.chats.length === 0) {
      console.warn(`[Watcher] Skipping rule for ${r.webhook_url}: chats array is required (no default-all)`);
      continue;
    }
    validRules.push({
      webhook_url: r.webhook_url,
      chats: r.chats,
      events: Array.isArray(r.events) ? r.events : undefined,
      debounce_ms: typeof r.debounce_ms === 'number' ? r.debounce_ms : 3000,
      secret: typeof r.secret === 'string' ? r.secret : undefined,
    });
  }

  const pollInterval = parseInt(process.env.WATCH_POLL_INTERVAL_MS || '5000', 10);
  const stateFile = process.env.WATCH_STATE_FILE || path.join(os.homedir(), '.imessage-mcp', 'watch-state.json');

  return {
    enabled: isEnabled,
    poll_interval_ms: Number.isFinite(pollInterval) && pollInterval > 0 ? pollInterval : 5000,
    state_file: stateFile,
    rules: validRules,
  };
}

export class WatcherService {
  private config: WatcherConfig;
  private stateFilePath: string;
  private state: WatchState;
  private pendingDispatches = new Map<string, PendingDispatch>();
  private pollTimer: NodeJS.Timeout | null = null;
  private checkDebounceTimer: NodeJS.Timeout | null = null;
  private fileWatcher: fs.FSWatcher | null = null;
  private isChecking = false;
  private pendingRecheck = false;
  private resourceNotifier: ResourceNotificationTarget | null = null;

  constructor(config: WatcherConfig, resourceNotifier: ResourceNotificationTarget | null = null) {
    this.config = config;
    this.resourceNotifier = resourceNotifier;
    this.stateFilePath = config.state_file || path.join(os.homedir(), '.imessage-mcp', 'watch-state.json');
    this.state = this.loadState();
  }

  public getState(): WatchState {
    return { ...this.state };
  }

  private loadState(): WatchState {
    if (fs.existsSync(this.stateFilePath)) {
      try {
        const raw = fs.readFileSync(this.stateFilePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (typeof parsed.last_seen_msg_id === 'number') {
          return {
            version: parsed.version || 1,
            last_seen_msg_id: parsed.last_seen_msg_id,
            receipt_state: parsed.receipt_state || {},
            updated_at_iso: parsed.updated_at_iso || new Date().toISOString(),
          };
        }
      } catch (err: any) {
        console.warn(`[Watcher] Could not read existing state file ${this.stateFilePath}: ${err.message}`);
      }
    }

    return {
      version: 1,
      last_seen_msg_id: -1,
      receipt_state: {},
      updated_at_iso: new Date().toISOString(),
    };
  }

  public saveState(): void {
    try {
      const dir = path.dirname(this.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.state.updated_at_iso = new Date().toISOString();
      fs.writeFileSync(this.stateFilePath, JSON.stringify(this.state, null, 2), 'utf8');
    } catch (err: any) {
      console.error(`[Watcher] Failed to write state file ${this.stateFilePath}: ${err.message}`);
    }
  }

  public async start(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    if (this.state.last_seen_msg_id < 0) {
      await this.initializeBaseline();
    }

    this.startFilesystemWatcher();

    const interval = this.config.poll_interval_ms || 5000;
    this.pollTimer = setInterval(() => {
      this.scheduleCheck();
    }, interval);

    await this.checkChanges();
  }

  public async stop(): Promise<void> {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.checkDebounceTimer) {
      clearTimeout(this.checkDebounceTimer);
      this.checkDebounceTimer = null;
    }
    if (this.fileWatcher) {
      this.fileWatcher.close();
      this.fileWatcher = null;
    }

    for (const pending of this.pendingDispatches.values()) {
      clearTimeout(pending.timer);
    }
    this.pendingDispatches.clear();
    this.saveState();
  }

  private async initializeBaseline(): Promise<void> {
    try {
      const stdout = await runImessageCli(['check-changes', '--since-id', '0', '--json']);
      const parsed: ChangesCliResult = JSON.parse(stdout);
      this.state.last_seen_msg_id = parsed.max_msg_id || 0;
      this.state.receipt_state = parsed.receipt_state || {};
      this.saveState();
    } catch (err: any) {
      console.warn(`[Watcher] Baseline initialization query failed: ${err.message}`);
      this.state.last_seen_msg_id = 0;
      this.saveState();
    }
  }

  private startFilesystemWatcher(): void {
    const dbPath = process.env.IMESSAGE_DB_PATH
      ? path.resolve(process.env.IMESSAGE_DB_PATH)
      : path.join(os.homedir(), 'Library', 'Messages', 'chat.db');

    const watchDir = path.dirname(dbPath);
    if (!fs.existsSync(watchDir)) {
      return;
    }

    try {
      this.fileWatcher = fs.watch(watchDir, (eventType, filename) => {
        if (!filename) {
          this.scheduleCheck();
          return;
        }
        const name = filename.toString();
        if (name.includes('chat.db')) {
          this.scheduleCheck();
        }
      });
    } catch (err: any) {
      console.warn(`[Watcher] fs.watch on ${watchDir} failed: ${err.message}. Using fallback poll.`);
    }
  }

  public scheduleCheck(): void {
    if (this.checkDebounceTimer) {
      clearTimeout(this.checkDebounceTimer);
    }
    this.checkDebounceTimer = setTimeout(() => {
      this.checkChanges();
    }, 200);
  }

  public async checkChanges(): Promise<void> {
    if (this.isChecking) {
      this.pendingRecheck = true;
      return;
    }

    this.isChecking = true;
    try {
      const sinceId = Math.max(0, this.state.last_seen_msg_id);
      const receiptJson = JSON.stringify(this.state.receipt_state || {});
      const stdout = await runImessageCli([
        'check-changes',
        '--since-id', String(sinceId),
        '--receipt-state', receiptJson,
        '--json'
      ]);

      const result: ChangesCliResult = JSON.parse(stdout);

      const hadNewMessages = Array.isArray(result.new_messages) && result.new_messages.length > 0;
      const hadReceiptEvents = Array.isArray(result.receipt_events) && result.receipt_events.length > 0;

      if (hadNewMessages) {
        for (const msg of result.new_messages) {
          this.handleEvent(msg.event, msg.chat_id, msg.chat_identifiers, msg.msg_id, msg.occurred_at_iso);
        }
      }

      if (hadReceiptEvents) {
        for (const rec of result.receipt_events) {
          this.handleEvent(rec.event, rec.chat_id, rec.chat_identifiers, rec.msg_id, rec.occurred_at_iso);
        }
      }

      if (typeof result.max_msg_id === 'number' && result.max_msg_id > this.state.last_seen_msg_id) {
        this.state.last_seen_msg_id = result.max_msg_id;
      }

      if (result.receipt_state) {
        this.state.receipt_state = {
          ...this.state.receipt_state,
          ...result.receipt_state,
        };
      }

      if (hadNewMessages || hadReceiptEvents) {
        this.saveState();
        if (this.resourceNotifier && hadNewMessages) {
          try {
            await this.resourceNotifier.sendResourceUpdated({ uri: 'resource://messages/recent' });
          } catch {
            // Ignored if client not subscribed
          }
        }
      }
    } catch (err: any) {
      console.warn(`[Watcher] Check changes failed: ${err.message}`);
    } finally {
      this.isChecking = false;
      if (this.pendingRecheck) {
        this.pendingRecheck = false;
        setImmediate(() => this.checkChanges());
      }
    }
  }

  private handleEvent(
    event: WatchEventType,
    chatId: number,
    chatIdentifiers: string[],
    msgId: number,
    occurredAtIso: string
  ): void {
    const rules = this.config.rules;
    for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
      const rule = rules[ruleIndex];
      if (ruleMatchesEvent(rule, event, chatId, chatIdentifiers)) {
        this.queueDispatch(ruleIndex, rule, event, chatId, msgId, occurredAtIso);
      }
    }
  }

  private queueDispatch(
    ruleIndex: number,
    rule: WatchRule,
    event: WatchEventType,
    chatId: number,
    msgId: number,
    occurredAtIso: string
  ): void {
    const key = `${ruleIndex}:${chatId}:${event}`;
    const debounceMs = typeof rule.debounce_ms === 'number' ? rule.debounce_ms : 3000;
    const existing = this.pendingDispatches.get(key);

    if (existing) {
      existing.count += 1;
      existing.newest_msg_id = Math.max(existing.newest_msg_id, msgId);
      existing.occurred_at_iso = occurredAtIso;
    } else {
      const sinceMsgIdHint = Math.max(0, msgId - 1);
      const timer = setTimeout(() => {
        this.fireDispatch(key);
      }, debounceMs);

      this.pendingDispatches.set(key, {
        ruleIndex,
        rule,
        event,
        chat_id: chatId,
        newest_msg_id: msgId,
        count: 1,
        since_msg_id_hint: sinceMsgIdHint,
        occurred_at_iso: occurredAtIso,
        timer,
      });
    }
  }

  private async fireDispatch(key: string): Promise<void> {
    const item = this.pendingDispatches.get(key);
    if (!item) {
      return;
    }

    this.pendingDispatches.delete(key);

    const payload: WebhookPayload = {
      event: item.event,
      chat_id: item.chat_id,
      newest_msg_id: item.newest_msg_id,
      count: item.count,
      since_msg_id_hint: item.since_msg_id_hint,
      occurred_at_iso: item.occurred_at_iso,
    };

    await deliverWebhook(item.rule.webhook_url, payload, item.rule.secret);
  }
}

let activeWatcher: WatcherService | null = null;

export function initGlobalWatcher(resourceNotifier: ResourceNotificationTarget | null = null): WatcherService | null {
  if (activeWatcher) {
    return activeWatcher;
  }

  const config = parseWatcherConfig();
  if (!config || !config.enabled) {
    return null;
  }

  activeWatcher = new WatcherService(config, resourceNotifier);
  activeWatcher.start().catch((err) => {
    console.error(`[Watcher] Failed to start watcher service: ${err.message}`);
  });

  return activeWatcher;
}

export async function stopGlobalWatcher(): Promise<void> {
  if (activeWatcher) {
    await activeWatcher.stop();
    activeWatcher = null;
  }
}
