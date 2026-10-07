import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

export interface ScheduledMessage {
  id: string;
  recipient: string;
  message?: string | null;
  attachment?: string | null;
  effect?: string | null;
  effect_type?: 'bubble' | 'screen' | null;
  target_time: string;
  scheduled_for: string;
  status: 'pending' | 'scheduled' | 'sent' | 'canceled' | 'failed';
  created_at: string;
  sent_at?: string;
  error?: string;
  source: 'server' | 'native';
}

export interface ScheduleMessageOptions {
  recipient: string;
  message?: string | null;
  attachment?: string | null;
  effect?: string | null;
  schedule_at: string;
}

export const EFFECT_MAP: Record<string, { id: string; type: 'bubble' | 'screen'; canonical: string }> = {
  // Bubble effects
  slam: { id: 'com.apple.MobileSMS.expressivesend.impact', type: 'bubble', canonical: 'slam' },
  impact: { id: 'com.apple.MobileSMS.expressivesend.impact', type: 'bubble', canonical: 'slam' },
  loud: { id: 'com.apple.MobileSMS.expressivesend.loud', type: 'bubble', canonical: 'loud' },
  gentle: { id: 'com.apple.MobileSMS.expressivesend.gentle', type: 'bubble', canonical: 'gentle' },
  invisible_ink: { id: 'com.apple.MobileSMS.expressivesend.invisibleink', type: 'bubble', canonical: 'invisible_ink' },
  invisibleink: { id: 'com.apple.MobileSMS.expressivesend.invisibleink', type: 'bubble', canonical: 'invisible_ink' },
  // Screen effects
  echo: { id: 'com.apple.messages.effect.CKEchoEffect', type: 'screen', canonical: 'echo' },
  spotlight: { id: 'com.apple.messages.effect.CKSpotlightEffect', type: 'screen', canonical: 'spotlight' },
  balloons: { id: 'com.apple.messages.effect.CKHappyBirthdayEffect', type: 'screen', canonical: 'balloons' },
  birthday: { id: 'com.apple.messages.effect.CKHappyBirthdayEffect', type: 'screen', canonical: 'balloons' },
  confetti: { id: 'com.apple.messages.effect.CKConfettiEffect', type: 'screen', canonical: 'confetti' },
  love: { id: 'com.apple.messages.effect.CKHeartEffect', type: 'screen', canonical: 'love' },
  heart: { id: 'com.apple.messages.effect.CKHeartEffect', type: 'screen', canonical: 'love' },
  lasers: { id: 'com.apple.messages.effect.CKLasersEffect', type: 'screen', canonical: 'lasers' },
  fireworks: { id: 'com.apple.messages.effect.CKFireworksEffect', type: 'screen', canonical: 'fireworks' },
  shooting_star: { id: 'com.apple.messages.effect.CKShootingStarEffect', type: 'screen', canonical: 'shooting_star' },
  shootingstar: { id: 'com.apple.messages.effect.CKShootingStarEffect', type: 'screen', canonical: 'shooting_star' },
  celebration: { id: 'com.apple.messages.effect.CKSparklesEffect', type: 'screen', canonical: 'celebration' },
  sparkles: { id: 'com.apple.messages.effect.CKSparklesEffect', type: 'screen', canonical: 'celebration' }
};

export function normalizeEffect(rawEffect?: string | null): { name: string; type: 'bubble' | 'screen'; styleId: string } | null {
  if (!rawEffect) return null;
  const key = rawEffect.trim().toLowerCase();
  const entry = EFFECT_MAP[key];
  if (!entry) {
    const valid = Array.from(new Set(Object.values(EFFECT_MAP).map((v) => v.canonical))).join(', ');
    throw new Error(`Unsupported message effect "${rawEffect}". Supported effects: ${valid}`);
  }
  return { name: entry.canonical, type: entry.type, styleId: entry.id };
}

export function parseScheduleTime(input: string): Date {
  const trimmed = input.trim();
  const relMatch = trimmed.match(
    /^\+?(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)$/i
  );
  if (relMatch) {
    const val = parseFloat(relMatch[1]);
    const unit = relMatch[2].toLowerCase();
    let ms = 0;
    if (unit.startsWith('s')) {
      ms = val * 1000;
    } else if (unit.startsWith('m')) {
      ms = val * 60 * 1000;
    } else if (unit.startsWith('h')) {
      ms = val * 3600 * 1000;
    } else if (unit.startsWith('d')) {
      ms = val * 86400 * 1000;
    } else if (unit.startsWith('w')) {
      ms = val * 7 * 86400 * 1000;
    }
    return new Date(Date.now() + ms);
  }

  const d = new Date(trimmed);
  if (isNaN(d.getTime())) {
    throw new Error(
      `Invalid schedule_at format: "${input}". Provide an ISO 8601 string (e.g. "2026-10-07T12:00:00Z") or relative offset (e.g. "+15m", "+1h").`
    );
  }
  return d;
}

export function getScheduleStoragePath(): string {
  if (process.env.IMESSAGE_SCHEDULE_PATH) {
    return path.resolve(process.env.IMESSAGE_SCHEDULE_PATH);
  }
  return path.join(os.homedir(), '.imessage-mcp', 'scheduled.json');
}

export function readScheduledMessages(): ScheduledMessage[] {
  const filePath = getScheduleStoragePath();
  if (!fs.existsSync(filePath)) {
    return [];
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function writeScheduledMessages(messages: ScheduledMessage[]): void {
  const filePath = getScheduleStoragePath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(filePath, JSON.stringify(messages, null, 2), { mode: 0o600 });
}

const activeTimers = new Map<string, NodeJS.Timeout>();

export function clearAllScheduledTimers(): void {
  for (const timer of activeTimers.values()) {
    clearTimeout(timer);
  }
  activeTimers.clear();
}

export type MessageDispatcher = (item: ScheduledMessage) => Promise<string>;

let globalDispatcher: MessageDispatcher | null = null;

export function setGlobalDispatcher(dispatcher: MessageDispatcher): void {
  globalDispatcher = dispatcher;
}

export async function scheduleMessage(
  options: ScheduleMessageOptions,
  customDispatcher?: MessageDispatcher
): Promise<ScheduledMessage & { scheduled_message_id: string; instructions: string }> {
  const { recipient, message, attachment, effect, schedule_at } = options;
  if (!recipient) {
    throw new Error('Missing required parameter "recipient"');
  }
  if (!message && !attachment) {
    throw new Error('Missing content to send: provide "message" and/or "attachment"');
  }

  const targetDate = parseScheduleTime(schedule_at);
  const now = Date.now();
  if (targetDate.getTime() <= now - 5000) {
    throw new Error('Scheduled delivery time must be in the future.');
  }

  const normalized = normalizeEffect(effect);
  const id = `sched_${crypto.randomBytes(8).toString('hex')}`;
  const targetIso = targetDate.toISOString();

  const item: ScheduledMessage = {
    id,
    recipient,
    message: message || null,
    attachment: attachment || null,
    effect: normalized ? normalized.name : null,
    effect_type: normalized ? normalized.type : null,
    target_time: targetIso,
    scheduled_for: targetIso,
    status: 'pending',
    created_at: new Date().toISOString(),
    source: 'server'
  };

  const stored = readScheduledMessages();
  stored.push(item);
  writeScheduledMessages(stored);

  const delayMs = Math.max(0, targetDate.getTime() - Date.now());
  const dispatcher = customDispatcher || globalDispatcher;

  if (delayMs <= 2147483647 && dispatcher) {
    const timer = setTimeout(async () => {
      activeTimers.delete(id);
      try {
        const latestList = readScheduledMessages();
        const currentItem = latestList.find((m) => m.id === id);
        if (!currentItem || currentItem.status !== 'pending') {
          return;
        }
        await dispatcher(currentItem);
        currentItem.status = 'sent';
        currentItem.sent_at = new Date().toISOString();
        writeScheduledMessages(latestList);
      } catch (err: any) {
        const latestList = readScheduledMessages();
        const currentItem = latestList.find((m) => m.id === id);
        if (currentItem) {
          currentItem.status = 'failed';
          currentItem.error = err.message || String(err);
          writeScheduledMessages(latestList);
        }
      }
    }, delayMs);
    timer.unref();
    activeTimers.set(id, timer);
  }

  return {
    ...item,
    status: 'scheduled',
    scheduled_message_id: id,
    instructions:
      'Message scheduled successfully. Use imessage_list_scheduled_messages to inspect pending sends or imessage_cancel_scheduled_message to cancel.'
  };
}

export async function listScheduledMessages(filterStatus?: string): Promise<ScheduledMessage[]> {
  const stored = readScheduledMessages();
  if (!filterStatus || filterStatus === 'all') {
    return stored;
  }
  return stored.filter((m) => m.status === filterStatus);
}

export async function cancelScheduledMessage(
  scheduleId: string
): Promise<{ canceled: boolean; id: string; message?: string; error?: string }> {
  if (!scheduleId) {
    throw new Error('Missing required parameter "schedule_id"');
  }

  const timer = activeTimers.get(scheduleId);
  if (timer) {
    clearTimeout(timer);
    activeTimers.delete(scheduleId);
  }

  const stored = readScheduledMessages();
  const item = stored.find((m) => m.id === scheduleId);
  if (!item) {
    return {
      canceled: false,
      id: scheduleId,
      error: `Scheduled message "${scheduleId}" not found.`
    };
  }

  if (item.status === 'canceled') {
    return {
      canceled: true,
      id: scheduleId,
      message: `Scheduled message "${scheduleId}" is already canceled.`
    };
  }

  if (item.status === 'sent') {
    return {
      canceled: false,
      id: scheduleId,
      error: `Cannot cancel scheduled message "${scheduleId}" because it has already been sent.`
    };
  }

  item.status = 'canceled';
  writeScheduledMessages(stored);

  return {
    canceled: true,
    id: scheduleId,
    message: `Scheduled message "${scheduleId}" canceled successfully.`
  };
}

export function initScheduler(dispatcher: MessageDispatcher): void {
  setGlobalDispatcher(dispatcher);
  clearAllScheduledTimers();
  const stored = readScheduledMessages();
  const now = Date.now();

  for (const item of stored) {
    if (item.status === 'pending') {
      const targetTime = new Date(item.target_time).getTime();
      const delayMs = targetTime - now;
      if (delayMs > 0 && delayMs <= 2147483647) {
        const timer = setTimeout(async () => {
          activeTimers.delete(item.id);
          try {
            const latestList = readScheduledMessages();
            const currentItem = latestList.find((m) => m.id === item.id);
            if (!currentItem || currentItem.status !== 'pending') return;
            await dispatcher(currentItem);
            currentItem.status = 'sent';
            currentItem.sent_at = new Date().toISOString();
            writeScheduledMessages(latestList);
          } catch (err: any) {
            const latestList = readScheduledMessages();
            const currentItem = latestList.find((m) => m.id === item.id);
            if (currentItem) {
              currentItem.status = 'failed';
              currentItem.error = err.message || String(err);
              writeScheduledMessages(latestList);
            }
          }
        }, delayMs);
        timer.unref();
        activeTimers.set(item.id, timer);
      }
    }
  }
}
