import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { executeToolCall } from '../src/index.js';
import { clearAllScheduledTimers } from '../src/scheduler.js';

describe('Ambient Context Envelope (Approach A - TDD)', () => {
  let tempSchedulePath: string;

  beforeEach(() => {
    tempSchedulePath = path.join(os.tmpdir(), `test_ambient_sched_${Date.now()}_${Math.random().toString(36).slice(2)}.json`);
    process.env.IMESSAGE_SCHEDULE_PATH = tempSchedulePath;
  });

  afterEach(() => {
    clearAllScheduledTimers();
    if (fs.existsSync(tempSchedulePath)) {
      try {
        fs.unlinkSync(tempSchedulePath);
      } catch {}
    }
    delete process.env.IMESSAGE_SCHEDULE_PATH;
  });

  it('includes ambient context with zero pending scheduled messages in dry_run preview', async () => {
    const res = await executeToolCall('imessage_send_message', {
      recipient: 'Paul Atreides (+15550199808)',
      message: 'Fear is the mind-killer',
      dry_run: true
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.content[0].type === 'text' ? res.content[0].text : '{}');
    expect(data.status).toBe('preview');
    expect(data.ambient).toBeDefined();
    expect(data.ambient.pending_scheduled_count).toBe(0);
    expect(data.ambient.next_scheduled).toBeNull();
  });

  it('includes ambient context reflecting queued scheduled messages in preview and dispatch', async () => {
    const targetTime1 = new Date(Date.now() + 3600 * 1000).toISOString();
    const targetTime2 = new Date(Date.now() + 7200 * 1000).toISOString();

    // 1. Schedule a message for Paul Atreides
    const schedRes = await executeToolCall('imessage_send_message', {
      recipient: 'Paul Atreides (+15550199808)',
      message: 'The sleeper has awakened',
      effect: 'lasers',
      schedule_at: targetTime1,
      dry_run: false
    });
    expect(schedRes.isError).toBeFalsy();
    const schedData = JSON.parse(schedRes.content[0].type === 'text' ? schedRes.content[0].text : '{}');
    expect(schedData.status).toBe('scheduled');
    expect(schedData.ambient).toBeDefined();
    expect(schedData.ambient.pending_scheduled_count).toBe(1);
    expect(schedData.ambient.next_scheduled.recipient).toBe('Paul Atreides (+15550199808)');
    expect(schedData.ambient.next_scheduled.effect).toBe('lasers');

    // 2. Schedule a second message for Chani further in the future
    await executeToolCall('imessage_send_message', {
      recipient: 'Chani (+15550199480)',
      message: 'Meet at Sietch Tabr',
      schedule_at: targetTime2,
      dry_run: false
    });

    // 3. Dry run preview of a third message to Stilgar
    const previewRes = await executeToolCall('imessage_send_message', {
      recipient: 'Stilgar (+15550199485)',
      message: 'Usul, we have wormsign',
      dry_run: true
    });
    expect(previewRes.isError).toBeFalsy();
    const previewData = JSON.parse(previewRes.content[0].type === 'text' ? previewRes.content[0].text : '{}');
    expect(previewData.ambient).toBeDefined();
    expect(previewData.ambient.pending_scheduled_count).toBe(2);
    // next_scheduled must be the earliest upcoming message (Paul)
    expect(previewData.ambient.next_scheduled.recipient).toBe('Paul Atreides (+15550199808)');
    expect(previewData.ambient.next_scheduled.scheduled_for).toBe(targetTime1);

    // 4. Cancel the earliest scheduled message
    const cancelRes = await executeToolCall('imessage_cancel_scheduled_message', {
      schedule_id: schedData.scheduled_message_id
    });
    expect(cancelRes.isError).toBeFalsy();
    const cancelData = JSON.parse(cancelRes.content[0].type === 'text' ? cancelRes.content[0].text : '{}');
    expect(cancelData.canceled).toBe(true);
    expect(cancelData.ambient).toBeDefined();
    expect(cancelData.ambient.pending_scheduled_count).toBe(1);
    expect(cancelData.ambient.next_scheduled.recipient).toBe('Chani (+15550199480)');
  });

  it('includes ambient context in read_messages when with_meta is true', async () => {
    // Schedule a message
    const targetTime = new Date(Date.now() + 3600 * 1000).toISOString();
    await executeToolCall('imessage_send_message', {
      recipient: 'Duncan Idaho (+15550199483)',
      message: 'Swordsmanship practice',
      schedule_at: targetTime,
      dry_run: false
    });

    const readRes = await executeToolCall('imessage_read_messages', {
      chat: '1',
      limit: 5,
      with_meta: true
    });

    expect(readRes.isError).toBeFalsy();
    const readData = JSON.parse(readRes.content[0].type === 'text' ? readRes.content[0].text : '{}');
    expect(readData.messages).toBeDefined();
    expect(readData.ambient).toBeDefined();
    expect(readData.ambient.pending_scheduled_count).toBe(1);
    expect(readData.ambient.next_scheduled.recipient).toBe('Duncan Idaho (+15550199483)');
  });
});
