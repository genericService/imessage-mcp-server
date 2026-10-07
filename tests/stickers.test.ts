import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import plistlib from 'plistlib';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PYTHON = '/usr/bin/python3';
const CLI = path.resolve(__dirname, '../bin/imessage');
const FIXTURE_BUILDER = path.resolve(__dirname, 'fixtures/build_chat_db.py');

describe('Sticker and Media Payload Handling (TDD)', () => {
  let testDbPath: string;
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-test-'));
    testDbPath = path.join(tempDir, 'chat.db');
    execFileSync(PYTHON, [FIXTURE_BUILDER, testDbPath]);
    process.env.IMESSAGE_DB_PATH = testDbPath;
    process.env.IMESSAGE_SSH_FDA = 'false';
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    delete process.env.IMESSAGE_DB_PATH;
  });

  async function runCliJson(args: string[]): Promise<any> {
    const { stdout } = await execFileAsync(PYTHON, [CLI, ...args, '--json'], {
      env: { ...process.env, IMESSAGE_DB_PATH: testDbPath }
    });
    return JSON.parse(stdout);
  }

  function insertStickerMessage(params: {
    msgId: number;
    chatId: number;
    handleId: number;
    text: string;
    isFromMe: number;
    attachmentId: number;
    filename: string;
    mimeType: string;
    isSticker: number;
    stickerPack?: string;
    stickerDescription?: string;
    emojiShortDesc?: string;
  }): void {
    const pythonScript = `
import sqlite3, sys, plistlib

db_path = sys.argv[1]
conn = sqlite3.connect(db_path)
c = conn.cursor()

user_info = None
attr_info = None

pack = ${params.stickerPack ? JSON.stringify(params.stickerPack) : 'None'}
desc = ${params.stickerDescription ? JSON.stringify(params.stickerDescription) : 'None'}
emoji_desc = ${params.emojiShortDesc ? JSON.stringify(params.emojiShortDesc) : 'None'}

if pack or desc:
    attr_dict = {}
    if pack:
        attr_dict['bundle-id'] = pack
        attr_dict['pack-name'] = pack
    if desc:
        attr_dict['accessibility-label'] = desc
    attr_info = plistlib.dumps(attr_dict, fmt=plistlib.FMT_BINARY)

c.execute("""
    INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date, cache_has_attachments)
    VALUES (?, ?, ?, ?, ?, 800000000000000000, 1)
""", (${params.msgId}, f"GUID-${params.msgId}", ${JSON.stringify(params.text)}, ${params.handleId}, ${params.isFromMe}))

c.execute("""
    INSERT INTO chat_message_join (chat_id, message_id, message_date)
    VALUES (?, ?, 800000000000000000)
""", (${params.chatId}, ${params.msgId}))

c.execute("""
    INSERT INTO attachment (ROWID, guid, filename, mime_type, transfer_name, total_bytes, is_sticker, attribution_info, emoji_image_short_description)
    VALUES (?, ?, ?, ?, ?, 1024, ?, ?, ?)
""", (${params.attachmentId}, f"ATT-GUID-${params.attachmentId}", ${JSON.stringify(params.filename)}, ${JSON.stringify(params.mimeType)}, "sticker.heic", ${params.isSticker}, attr_info, emoji_desc))

c.execute("""
    INSERT INTO message_attachment_join (message_id, attachment_id)
    VALUES (?, ?)
""", (${params.msgId}, ${params.attachmentId}))

conn.commit()
conn.close()
`;
    execFileSync(PYTHON, ['-c', pythonScript, testDbPath]);
  }

  it('surfaces sticker metadata and synthesizes [sticker: "description"] text from ufffc', async () => {
    const dummyFile = path.join(tempDir, 'worm_sticker.heic');
    fs.writeFileSync(dummyFile, 'dummy heic content');

    // Message 501: text is raw "\ufffc", attachment has sticker metadata
    insertStickerMessage({
      msgId: 501,
      chatId: 7, // Chani
      handleId: 1,
      text: '\ufffc',
      isFromMe: 0,
      attachmentId: 9501,
      filename: dummyFile,
      mimeType: 'image/heic',
      isSticker: 1,
      stickerPack: 'com.dune.fremen.stickers',
      stickerDescription: 'Shai-Hulud Sandworm'
    });

    const res = await runCliJson(['recent', '7', '--limit', '5']);
    const msg = res.find((m: any) => m.msg_id === 501);

    expect(msg).toBeDefined();
    // Synthesizes replacement of \ufffc with readable sticker label
    expect(msg.text).toContain('[sticker');
    expect(msg.text).toContain('Shai-Hulud Sandworm');

    // Attachment fields surface sticker metadata
    expect(msg.attachments).toBeDefined();
    expect(msg.attachments.length).toBe(1);
    const att = msg.attachments[0];
    expect(att.is_sticker).toBe(true);
    expect(att.sticker_pack).toBe('com.dune.fremen.stickers');
    expect(att.sticker_description).toBe('Shai-Hulud Sandworm');
  });

  it('synthesizes inline ufffc within text as [sticker] when no description is present', async () => {
    const dummyFile = path.join(tempDir, 'crysknife_sticker.png');
    fs.writeFileSync(dummyFile, 'dummy png content');

    // Message 502: text with inline \ufffc, sticker without description
    insertStickerMessage({
      msgId: 502,
      chatId: 7,
      handleId: 1,
      text: 'May thy knife chip and shatter \ufffc',
      isFromMe: 0,
      attachmentId: 9502,
      filename: dummyFile,
      mimeType: 'image/png',
      isSticker: 1
    });

    const res = await runCliJson(['recent', '7', '--limit', '5']);
    const msg = res.find((m: any) => m.msg_id === 502);

    expect(msg).toBeDefined();
    expect(msg.text).toBe('May thy knife chip and shatter [sticker]');
    expect(msg.attachments[0].is_sticker).toBe(true);
  });

  it('detects stickers from StickerCache path even if is_sticker column is 0', async () => {
    const cacheDir = path.join(tempDir, 'Library/Messages/StickerCache');
    fs.mkdirSync(cacheDir, { recursive: true });
    const stickerFile = path.join(cacheDir, 'atreides_banner.heic');
    fs.writeFileSync(stickerFile, 'dummy heic');

    insertStickerMessage({
      msgId: 503,
      chatId: 8, // Paul Atreides
      handleId: 2,
      text: '\ufffc',
      isFromMe: 0,
      attachmentId: 9503,
      filename: stickerFile,
      mimeType: 'image/heic',
      isSticker: 0 // column is 0, but path is in StickerCache
    });

    const res = await runCliJson(['recent', '8', '--limit', '5']);
    const msg = res.find((m: any) => m.msg_id === 503);

    expect(msg).toBeDefined();
    expect(msg.text).toBe('[sticker]');
    expect(msg.attachments[0].is_sticker).toBe(true);
  });

  it('extracts sticker metadata via attachment payload CLI', async () => {
    const dummyFile = path.join(tempDir, 'paul_genmoji.heic');
    fs.writeFileSync(dummyFile, 'dummy bytes');

    insertStickerMessage({
      msgId: 504,
      chatId: 8,
      handleId: 2,
      text: '\ufffc',
      isFromMe: 1,
      attachmentId: 9504,
      filename: dummyFile,
      mimeType: 'image/heic',
      isSticker: 1,
      emojiShortDesc: 'Muad\'Dib Desert Mouse'
    });

    const payload = await runCliJson(['attachment', '--message-id', '504']);
    expect(payload.is_sticker).toBe(true);
    expect(payload.sticker_description).toBe('Muad\'Dib Desert Mouse');
  });

  it('converts HEIC stickers to PNG in download-image to preserve transparency', async () => {
    // Create a real tiny 1x1 HEIC file or test conversion flag
    const stickerPath = path.join(tempDir, 'sticker.heic');
    const photoPath = path.join(tempDir, 'photo.heic');

    // Create valid 1x1 image via sips so sips conversion succeeds
    const basePng = path.join(tempDir, 'base.png');
    execFileSync('/usr/bin/sips', ['-s', 'format', 'png', '/System/Library/CoreServices/Finder.app/Contents/Resources/Finder.icns', '--out', basePng, '-z', '16', '16']);
    execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', basePng, '--out', stickerPath]);
    execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', basePng, '--out', photoPath]);

    insertStickerMessage({
      msgId: 505,
      chatId: 7,
      handleId: 1,
      text: '\ufffc',
      isFromMe: 0,
      attachmentId: 9505,
      filename: stickerPath,
      mimeType: 'image/heic',
      isSticker: 1,
      stickerDescription: 'Fremen Sietch'
    });

    // Normal non-sticker photo
    const pythonScript = `
import sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
c = conn.cursor()
c.execute("""
    INSERT INTO message (ROWID, guid, text, handle_id, is_from_me, date, cache_has_attachments)
    VALUES (506, 'GUID-506', 'Photo of Arrakeen', 1, 0, 800000000000000000, 1)
""")
c.execute("INSERT INTO chat_message_join (chat_id, message_id, message_date) VALUES (7, 506, 800000000000000000)")
c.execute("""
    INSERT INTO attachment (ROWID, guid, filename, mime_type, transfer_name, total_bytes, is_sticker)
    VALUES (9506, 'ATT-GUID-506', ?, 'image/heic', 'photo.heic', 1024, 0)
""", (${JSON.stringify(photoPath)},))
c.execute("INSERT INTO message_attachment_join (message_id, attachment_id) VALUES (506, 9506)")
conn.commit()
conn.close()
`;
    execFileSync(PYTHON, ['-c', pythonScript, testDbPath]);

    // Download sticker -> converts to PNG
    const stickerDl = await runCliJson(['download-image', '--message-id', '505']);
    expect(stickerDl.success).toBe(true);
    expect(stickerDl.is_sticker).toBe(true);
    expect(stickerDl.mime_type).toBe('image/png');
    expect(stickerDl.file_path.endsWith('.png')).toBe(true);

    // Download photo -> converts to JPEG
    const photoDl = await runCliJson(['download-image', '--message-id', '506']);
    expect(photoDl.success).toBe(true);
    expect(photoDl.is_sticker).toBe(false);
    expect(photoDl.mime_type).toBe('image/jpeg');
    expect(photoDl.file_path.endsWith('.jpg') || photoDl.file_path.endsWith('.jpeg')).toBe(true);
  });
});
