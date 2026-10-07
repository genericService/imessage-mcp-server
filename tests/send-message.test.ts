import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import http from 'http';
import { executeToolCall, TOOLS, cliRunner } from '../src/index.js';

describe('iMessage Send Message Attachments & Preview (TDD)', () => {
  let tempLocalFile: string;
  let mockServer: http.Server;
  let mockServerUrl: string;

  beforeAll(async () => {
    // Create a temporary local image fixture
    tempLocalFile = path.join(os.tmpdir(), `test_flower_${Date.now()}.png`);
    // Minimal valid 1x1 PNG bytes
    const pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );
    fs.writeFileSync(tempLocalFile, pngBuffer);

    // Create a local HTTP server to test URL downloads
    mockServer = http.createServer((req, res) => {
      if (req.url === '/flower.png') {
        res.writeHead(200, { 'Content-Type': 'image/png' });
        res.end(pngBuffer);
      } else if (req.url === '/flower.jpg') {
        const jpgBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
        res.writeHead(200, { 'Content-Type': 'image/jpeg' });
        res.end(jpgBuffer);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    });

    await new Promise<void>((resolve) => {
      mockServer.listen(0, '127.0.0.1', () => {
        const addr = mockServer.address();
        if (typeof addr === 'object' && addr !== null) {
          mockServerUrl = `http://127.0.0.1:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (fs.existsSync(tempLocalFile)) {
      fs.unlinkSync(tempLocalFile);
    }
    await new Promise<void>((resolve) => mockServer.close(() => resolve()));
  });

  it('documents local path, HTTPS URL, and base64 options in tool schemas', () => {
    const sendTools = TOOLS.filter((t) => t.name === 'imessage_send_message' || t.name === 'send_message');
    expect(sendTools.length).toBe(2);

    for (const tool of sendTools) {
      const attachmentProp = tool.inputSchema.properties?.attachment;
      expect(attachmentProp).toBeDefined();
      expect(attachmentProp.description).toContain('base64');
      expect(attachmentProp.description).toContain('URL');
      expect(attachmentProp.description).toContain('POSIX');
    }
  });

  it('validates and inspects an existing local file attachment in dry_run preview', async () => {
    const res = await executeToolCall('imessage_send_message', {
      recipient: 'Paul Atreides (+15550199808)',
      message: 'Here is the flower from Arrakis',
      attachment: tempLocalFile,
      dry_run: true
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.content[0].type === 'text' ? res.content[0].text : '{}');
    expect(data.status).toBe('preview');
    expect(data.dry_run).toBe(true);
    expect(data.target_recipient).toBe('Paul Atreides (+15550199808)');
    expect(data.message_text).toBe('Here is the flower from Arrakis');
    expect(data.confirm_token).toMatch(/^cf_[a-f0-9]+/);

    // Must confirm the file exists and show size and type
    expect(data.attachment).toBe(tempLocalFile);
    expect(data.attachment_size).toBeGreaterThan(0);
    expect(data.attachment_type).toBe('image/png');
    expect(data.attachment_info).toMatchObject({
      path: tempLocalFile,
      size: data.attachment_size,
      type: 'image/png',
      mime_type: 'image/png'
    });
  });

  it('rejects preview with error when local attachment file does not exist', async () => {
    const nonexistentPath = path.join(os.tmpdir(), `nonexistent_${Date.now()}.png`);
    const res = await executeToolCall('imessage_send_message', {
      recipient: 'Chani (+15550199480)',
      message: 'This file is missing',
      attachment: nonexistentPath,
      dry_run: true
    });

    expect(res.isError).toBe(true);
    const errText = res.content[0].type === 'text' ? res.content[0].text : '';
    expect(errText).toContain('Attachment file not found');
  });

  it('downloads URL attachment to a temp file and reports size and type in dry_run preview', async () => {
    const fileUrl = `${mockServerUrl}/flower.png`;
    const res = await executeToolCall('imessage_send_message', {
      recipient: 'Chani (+15550199480)',
      message: 'Flower from web URL',
      attachment: fileUrl,
      dry_run: true
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.content[0].type === 'text' ? res.content[0].text : '{}');
    expect(data.status).toBe('preview');
    expect(data.attachment_size).toBeGreaterThan(0);
    expect(data.attachment_type).toBe('image/png');
    expect(typeof data.attachment).toBe('string');
    expect(fs.existsSync(data.attachment)).toBe(true);
    expect(data.attachment_info.source).toBe('url');
  });

  it('rejects preview with error when URL attachment returns 404', async () => {
    const fileUrl = `${mockServerUrl}/does-not-exist.png`;
    const res = await executeToolCall('imessage_send_message', {
      recipient: 'Chani (+15550199480)',
      message: 'Broken URL',
      attachment: fileUrl,
      dry_run: true
    });

    expect(res.isError).toBe(true);
    const errText = res.content[0].type === 'text' ? res.content[0].text : '';
    expect(errText.toLowerCase()).toContain('failed to download');
  });

  it('decodes base64 Data URI attachment to a temp file and reports size and type in dry_run preview', async () => {
    const dataUri =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    const res = await executeToolCall('imessage_send_message', {
      recipient: 'Jessica (+15550199481)',
      message: 'Flower as base64 Data URI',
      attachment: dataUri,
      dry_run: true
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.content[0].type === 'text' ? res.content[0].text : '{}');
    expect(data.status).toBe('preview');
    expect(data.attachment_size).toBe(70);
    expect(data.attachment_type).toBe('image/png');
    expect(fs.existsSync(data.attachment)).toBe(true);
    expect(data.attachment_info.source).toBe('base64');
  });

  it('decodes raw base64 attachment, infers mime type, and writes temp file in dry_run preview', async () => {
    const rawBase64 =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    const res = await executeToolCall('send_message', {
      to: 'Jessica (+15550199481)',
      message: 'Flower as raw base64',
      attachment: rawBase64,
      dry_run: true
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.content[0].type === 'text' ? res.content[0].text : '{}');
    expect(data.status).toBe('preview');
    expect(data.attachment_size).toBe(70);
    expect(data.attachment_type).toBe('image/png');
    expect(fs.existsSync(data.attachment)).toBe(true);
    expect(data.confirm_token).toBeDefined();
  });

  it('authorizes dispatch with confirm_token and sends the staged attachment', async () => {
    const dataUri =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

    // 1. Dry run preview
    const previewRes = await executeToolCall('imessage_send_message', {
      recipient: 'Gurney Halleck (+15550199482)',
      message: 'Flower preview',
      attachment: dataUri,
      dry_run: true
    });

    const preview = JSON.parse(previewRes.content[0].type === 'text' ? previewRes.content[0].text : '{}');
    expect(preview.confirm_token).toBeDefined();
    const stagedFile = preview.attachment;
    expect(fs.existsSync(stagedFile)).toBe(true);

    // 2. Mock cliRunner.run to verify CLI receives the staged temp file path
    const cliSpy = vi.spyOn(cliRunner, 'run').mockResolvedValueOnce('Message sent successfully!');

    const dispatchRes = await executeToolCall('imessage_send_message', {
      confirm_token: preview.confirm_token
    });

    expect(dispatchRes.isError).toBeFalsy();
    expect(cliSpy).toHaveBeenCalledWith([
      'send',
      'Gurney Halleck (+15550199482)',
      '-m',
      'Flower preview',
      '-a',
      stagedFile
    ]);

    cliSpy.mockRestore();
  });

  it('stages URL to temp file and dispatches when sent directly without dry_run', async () => {
    const fileUrl = `${mockServerUrl}/flower.png`;
    const cliSpy = vi.spyOn(cliRunner, 'run').mockResolvedValueOnce('Message sent successfully!');

    const res = await executeToolCall('imessage_send_message', {
      recipient: 'Duncan Idaho (+15550199483)',
      message: 'Direct flower send',
      attachment: fileUrl,
      dry_run: false
    });

    expect(res.isError).toBeFalsy();
    expect(cliSpy).toHaveBeenCalledTimes(1);
    const passedArgs = cliSpy.mock.calls[0][0];
    expect(passedArgs[0]).toBe('send');
    expect(passedArgs[1]).toBe('Duncan Idaho (+15550199483)');
    expect(passedArgs[2]).toBe('-m');
    expect(passedArgs[3]).toBe('Direct flower send');
    expect(passedArgs[4]).toBe('-a');
    expect(fs.existsSync(passedArgs[5])).toBe(true);

    cliSpy.mockRestore();
  });

  it('documents effect and schedule_at in send tool input schemas', () => {
    const sendTools = TOOLS.filter((t) => t.name === 'imessage_send_message' || t.name === 'send_message');
    for (const tool of sendTools) {
      expect(tool.inputSchema.properties?.effect).toBeDefined();
      expect(tool.inputSchema.properties?.schedule_at).toBeDefined();
    }
  });

  it('previews message with effect in dry_run mode', async () => {
    const res = await executeToolCall('imessage_send_message', {
      recipient: 'Paul Atreides (+15550199808)',
      message: 'Long live the fighters!',
      effect: 'lasers',
      dry_run: true
    });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.content[0].type === 'text' ? res.content[0].text : '{}');
    expect(data.status).toBe('preview');
    expect(data.effect).toBe('lasers');
    expect(data.effect_type).toBe('screen');
  });

  it('dispatches send with --effect flag passed to CLI', async () => {
    const cliSpy = vi.spyOn(cliRunner, 'run').mockResolvedValueOnce('Message sent successfully!');
    const res = await executeToolCall('imessage_send_message', {
      recipient: 'Paul Atreides (+15550199808)',
      message: 'Happy birthday from Arrakis',
      effect: 'balloons',
      dry_run: false
    });
    expect(res.isError).toBeFalsy();
    expect(cliSpy).toHaveBeenCalledWith([
      'send',
      'Paul Atreides (+15550199808)',
      '-m',
      'Happy birthday from Arrakis',
      '--effect',
      'balloons'
    ]);
    cliSpy.mockRestore();
  });

  it('previews scheduled message with target time in dry_run mode', async () => {
    const targetTime = new Date(Date.now() + 3600 * 1000).toISOString();
    const res = await executeToolCall('imessage_send_message', {
      recipient: 'Chani (+15550199480)',
      message: 'Meeting at Sietch Tabr',
      schedule_at: targetTime,
      dry_run: true
    });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.content[0].type === 'text' ? res.content[0].text : '{}');
    expect(data.status).toBe('preview');
    expect(data.scheduled).toBe(true);
    expect(data.scheduled_for).toBe(targetTime);
  });

  it('schedules a message for future delivery, lists it, and can cancel it', async () => {
    const targetTime = new Date(Date.now() + 7200 * 1000).toISOString();
    const res = await executeToolCall('imessage_send_message', {
      recipient: 'Stilgar (+15550199485)',
      message: 'The worm approaches',
      effect: 'confetti',
      schedule_at: targetTime,
      dry_run: false
    });
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.content[0].type === 'text' ? res.content[0].text : '{}');
    expect(data.status).toBe('scheduled');
    expect(data.scheduled_message_id).toBeDefined();
    expect(data.effect).toBe('confetti');

    // List scheduled messages
    const listRes = await executeToolCall('imessage_list_scheduled_messages', {});
    expect(listRes.isError).toBeFalsy();
    const listData = JSON.parse(listRes.content[0].type === 'text' ? listRes.content[0].text : '[]');
    const found = listData.find((m: any) => m.id === data.scheduled_message_id);
    expect(found).toBeDefined();
    expect(found.recipient).toBe('Stilgar (+15550199485)');
    expect(found.effect).toBe('confetti');

    // Cancel scheduled message
    const cancelRes = await executeToolCall('imessage_cancel_scheduled_message', {
      schedule_id: data.scheduled_message_id
    });
    expect(cancelRes.isError).toBeFalsy();
    const cancelData = JSON.parse(cancelRes.content[0].type === 'text' ? cancelRes.content[0].text : '{}');
    expect(cancelData.canceled).toBe(true);
  });
});
