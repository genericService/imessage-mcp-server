import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { fileURLToPath } from 'url';
import {
  scheduleMessage,
  runPendingScheduledMessages,
  readScheduledMessages,
  clearAllScheduledTimers
} from '../src/scheduler.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '../bin/imessage');
const PYTHON = '/usr/bin/python3';

describe('Scheduled Message CLI Runner (TDD)', () => {
  let tempSchedulePath: string;

  beforeEach(() => {
    tempSchedulePath = path.join(
      os.tmpdir(),
      `test_sched_cli_${Date.now()}_${Math.random().toString(36).slice(2)}.json`
    );
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

  async function runCli(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(PYTHON, [CLI, ...args], {
      env: { ...process.env, IMESSAGE_SCHEDULE_PATH: tempSchedulePath }
    });
    return stdout;
  }

  async function runCliJson(args: string[]): Promise<any> {
    const stdout = await runCli([...args, '--json']);
    return JSON.parse(stdout);
  }

  it('lists scheduled messages and reports status via CLI', async () => {
    const targetTime1 = new Date(Date.now() + 3600 * 1000).toISOString();
    const targetTime2 = new Date(Date.now() + 7200 * 1000).toISOString();

    await scheduleMessage({
      recipient: 'Paul Atreides (+15550199808)',
      message: 'The mystery of life isn’t a problem to solve',
      effect: 'lasers',
      schedule_at: targetTime1
    });

    await scheduleMessage({
      recipient: 'Chani (+15550199480)',
      message: 'Walk without rhythm',
      schedule_at: targetTime2
    });

    const list = await runCliJson(['schedule', 'list']);
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBe(2);
    expect(list[0].recipient).toBe('Paul Atreides (+15550199808)');
    expect(list[0].effect).toBe('lasers');
    expect(list[1].recipient).toBe('Chani (+15550199480)');

    const status = await runCliJson(['schedule', 'status']);
    expect(status.total).toBe(2);
    expect(status.pending).toBe(2);
    expect(status.sent).toBe(0);
    expect(status.canceled).toBe(0);
    expect(status.next_scheduled.recipient).toBe('Paul Atreides (+15550199808)');
  });

  it('cancels scheduled messages via CLI', async () => {
    const targetTime = new Date(Date.now() + 3600 * 1000).toISOString();
    const sched = await scheduleMessage({
      recipient: 'Duncan Idaho (+15550199483)',
      message: 'May thy knife chip and shatter',
      schedule_at: targetTime
    });

    const cancelRes = await runCliJson(['schedule', 'cancel', sched.id]);
    expect(cancelRes.success).toBe(true);
    expect(cancelRes.canceled).toBe(true);
    expect(cancelRes.id).toBe(sched.id);

    const pendingList = await runCliJson(['schedule', 'list', '--status', 'pending']);
    expect(pendingList.length).toBe(0);

    const canceledList = await runCliJson(['schedule', 'list', '--status', 'canceled']);
    expect(canceledList.length).toBe(1);
    expect(canceledList[0].id).toBe(sched.id);
  });

  it('runs due pending messages and leaves future messages untouched', async () => {
    const pastTime = new Date(Date.now() - 60 * 1000).toISOString();
    const futureTime = new Date(Date.now() + 3600 * 1000).toISOString();

    // Directly seed messages into storage
    const messages = [
      {
        id: 'sched_due_1',
        recipient: 'Stilgar (+15550199485)',
        message: 'Usul has called a big one',
        target_time: pastTime,
        scheduled_for: pastTime,
        status: 'pending' as const,
        created_at: new Date(Date.now() - 120 * 1000).toISOString(),
        source: 'server' as const
      },
      {
        id: 'sched_future_1',
        recipient: 'Lady Jessica (+15550199482)',
        message: 'I must not fear',
        target_time: futureTime,
        scheduled_for: futureTime,
        status: 'pending' as const,
        created_at: new Date().toISOString(),
        source: 'server' as const
      }
    ];
    fs.writeFileSync(tempSchedulePath, JSON.stringify(messages, null, 2));

    const dispatched: string[] = [];
    const processed = await runPendingScheduledMessages(async (item) => {
      dispatched.push(item.recipient);
      return 'sent';
    });

    expect(processed.length).toBe(1);
    expect(processed[0].id).toBe('sched_due_1');
    expect(dispatched).toEqual(['Stilgar (+15550199485)']);

    const updated = readScheduledMessages();
    const dueItem = updated.find((m) => m.id === 'sched_due_1');
    const futureItem = updated.find((m) => m.id === 'sched_future_1');

    expect(dueItem?.status).toBe('sent');
    expect(typeof dueItem?.sent_at).toBe('string');
    expect(futureItem?.status).toBe('pending');
  });
});
