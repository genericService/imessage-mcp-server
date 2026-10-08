import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs';

const execFileAsync = promisify(execFile);
const PYTHON = '/usr/bin/python3';
const CLI = path.resolve(__dirname, '../bin/imessage');
const FIXTURE_BUILDER = path.resolve(__dirname, 'fixtures/build_chat_db.py');
const MOCK_WHISPER = path.resolve(__dirname, 'fixtures/mock_whisper.py');

const TEST_DIR = path.join(os.tmpdir(), `imessage-transcribe-test-${process.pid}`);
const FIXTURE_DB = path.join(TEST_DIR, 'chat.db');
const INDEX_DIR = path.join(TEST_DIR, 'index_store');
const INDEX_DB = path.join(INDEX_DIR, 'index.db');
const MCP_DIR = path.join(TEST_DIR, 'imessage_mcp_home');
const CALL_COUNT_FILE = path.join(TEST_DIR, 'mock_calls.txt');

const BASE_ENV = {
  ...process.env,
  IMESSAGE_DB_PATH: FIXTURE_DB,
  INDEX_DB_PATH: INDEX_DB,
  IMESSAGE_MCP_DIR: MCP_DIR,
  TRANSCRIBE_WHISPER_BIN: MOCK_WHISPER,
  MOCK_CALL_LOG: CALL_COUNT_FILE,
  TRANSCRIBE_AUTO_DOWNLOAD: 'false',
  IMESSAGE_SSH_FDA: 'false',
  TZ: 'America/Los_Angeles',
  LC_ALL: 'C',
  LANG: 'C',
};

async function cli(args: string[], customEnv: Record<string, string> = {}): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(PYTHON, [CLI, ...args], {
      env: { ...BASE_ENV, ...customEnv },
    });
    return { stdout, stderr };
  } catch (err: any) {
    const stdout = err.stdout?.toString() || '';
    const stderr = err.stderr?.toString() || '';
    throw new Error(`CLI failed: ${stderr || stdout || err.message}`);
  }
}

async function cliJson(args: string[], customEnv: Record<string, string> = {}): Promise<any> {
  const { stdout } = await cli(args, customEnv);
  return JSON.parse(stdout);
}

describe('On-Device Voice Note Transcription', () => {
  beforeAll(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(MCP_DIR, { recursive: true, mode: 0o700 });
    fs.rmSync(FIXTURE_DB, { force: true });
    fs.rmSync(INDEX_DIR, { recursive: true, force: true });
    execFileSync(PYTHON, [FIXTURE_BUILDER, FIXTURE_DB], { env: BASE_ENV });
  });

  afterAll(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('prioritizes Apple existing transcript over local transcription engine', async () => {
    // Message 207 has Apple transcript "Apple says hello from Caladan"
    const payload = await cliJson(['attachment', '--message-id', '207', '--json']);
    expect(payload.is_audio).toBe(true);
    expect(payload.transcription).toBe('Apple says hello from Caladan');
    expect(payload.language).toBe('en');
    expect(payload.transcription_source).toBe('apple');
    expect(payload.transcription_status).toBe('ok');
  });

  it('triggers local engine when Apple transcript is missing and fills fields', async () => {
    // Message 208 has no Apple transcript; invokes mock whisper
    const payload = await cliJson(['attachment', '--message-id', '208', '--with-segments', '--json']);
    expect(payload.is_audio).toBe(true);
    expect(payload.transcription).toBe('Hola, te veo mañana para la reunión.');
    expect(payload.language).toBe('es');
    expect(payload.transcription_source).toBe('whisper');
    expect(payload.transcription_status).toBe('ok');
    expect(Array.isArray(payload.segments)).toBe(true);
    expect(payload.segments.length).toBeGreaterThan(0);
    expect(payload.segments[0].text).toContain('Hola');
    expect(typeof payload.segments[0].start).toBe('number');
    expect(typeof payload.segments[0].end).toBe('number');
  });

  it('skips engine on cache hit and returns cached transcription', async () => {
    // Second call for message 208 should read from cache even if mock whisper is set to fail
    const payload = await cliJson(['attachment', '--message-id', '208', '--json'], {
      MOCK_WHISPER_FAIL: '1',
    });
    expect(payload.transcription).toBe('Hola, te veo mañana para la reunión.');
    expect(payload.language).toBe('es');
    expect(payload.transcription_source).toBe('whisper');
    expect(payload.transcription_status).toBe('ok');
  });

  it('returns engine_unavailable status when whisper binary is missing', async () => {
    // Clear cache first for message 208 to test missing engine
    const spanishClip = path.resolve(__dirname, 'fixtures/spanish_sample.caf');
    const payload = await cliJson(['attachment', '--path', spanishClip, '--json'], {
      TRANSCRIBE_WHISPER_BIN: '/nonexistent/path/to/whisper-cli',
      INDEX_ENABLED: 'false',
      IMESSAGE_MCP_DIR: path.join(TEST_DIR, 'empty_cache'),
    });
    expect(payload.is_audio).toBe(true);
    expect(payload.transcription).toBeNull();
    expect(payload.language).toBeNull();
    expect(payload.transcription_source).toBeNull();
    expect(payload.transcription_status).toBe('engine_unavailable');
  });

  it('refuses too-long audio when exceeding TRANSCRIBE_MAX_SECONDS', async () => {
    const spanishClip = path.resolve(__dirname, 'fixtures/spanish_sample.caf');
    const payload = await cliJson(['attachment', '--path', spanishClip, '--json'], {
      TRANSCRIBE_MAX_SECONDS: '0.1', // 100ms threshold, clip is ~2.8s
      IMESSAGE_MCP_DIR: path.join(TEST_DIR, 'empty_cache2'),
    });
    expect(payload.is_audio).toBe(true);
    expect(payload.transcription).toBeNull();
    expect(payload.transcription_status).toBe('too_long');
    expect(payload.transcription_source).toBeNull();
  });

  it('returns failed status on subprocess execution timeout', async () => {
    const spanishClip = path.resolve(__dirname, 'fixtures/spanish_sample.caf');
    const payload = await cliJson(['attachment', '--path', spanishClip, '--json'], {
      TRANSCRIBE_JOB_TIMEOUT_SECONDS: '1',
      MOCK_WHISPER_DELAY: '3',
      IMESSAGE_MCP_DIR: path.join(TEST_DIR, 'empty_cache3'),
    });
    expect(payload.is_audio).toBe(true);
    expect(payload.transcription).toBeNull();
    expect(payload.transcription_status).toBe('failed');
  });

  it('returns pending status when queue wait timeout expires', async () => {
    const spanishClip = path.resolve(__dirname, 'fixtures/spanish_sample.caf');
    const lockDir = path.join(TEST_DIR, 'lock_test');
    fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
    const lockFile = path.join(lockDir, 'transcribe.lock');
    
    // Hold lock externally
    const fd = fs.openSync(lockFile, 'w');
    // Lock fd with python fcntl
    const locker = execFile(PYTHON, [
      '-c',
      `import fcntl, time, sys\nwith open("${lockFile}", "w") as f:\n  fcntl.flock(f, fcntl.LOCK_EX)\n  sys.stdout.write("locked\\n")\n  sys.stdout.flush()\n  time.sleep(5)`
    ]);
    
    // Wait for lock to be held
    await new Promise((resolve) => setTimeout(resolve, 500));

    try {
      const payload = await cliJson(['attachment', '--path', spanishClip, '--json'], {
        TRANSCRIBE_WAIT_MS: '200',
        IMESSAGE_MCP_DIR: lockDir,
      });
      expect(payload.is_audio).toBe(true);
      expect(payload.transcription_status).toBe('pending');
    } finally {
      locker.kill();
      try { fs.closeSync(fd); } catch {}
    }
  });

  it('cleans up temporary audio files and directories after transcription', async () => {
    const spanishClip = path.resolve(__dirname, 'fixtures/spanish_sample.caf');
    const tmpBefore = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('imsg_transcribe_'));
    
    await cliJson(['attachment', '--path', spanishClip, '--json'], {
      IMESSAGE_MCP_DIR: path.join(TEST_DIR, 'empty_cache4'),
    });

    const tmpAfter = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('imsg_transcribe_'));
    expect(tmpAfter.length).toBe(tmpBefore.length);
  });

  it('never logs transcript text or audio content to stderr or stdout logs', async () => {
    const spanishClip = path.resolve(__dirname, 'fixtures/spanish_sample.caf');
    const secretText = 'CONFIDENTIAL_SPICE_DISCOVERY_ON_ARRAKIS_12345';
    
    const { stdout, stderr } = await cli(['attachment', '--path', spanishClip, '--json'], {
      MOCK_WHISPER_TEXT: secretText,
      IMESSAGE_MCP_DIR: path.join(TEST_DIR, 'empty_cache5'),
    });

    // Stderr must NEVER contain the secret text
    expect(stderr).not.toContain(secretText);
    expect(stderr).not.toContain('CONFIDENTIAL');
    
    // Stdout JSON only contains it inside the structured payload
    const parsed = JSON.parse(stdout);
    expect(parsed.transcription).toBe(secretText);
  });

  it('formats voice note label with cached transcription in read and search tools', async () => {
    // Message 208 was cached in previous test with "Hola, te veo mañana para la reunión."
    const messages = await cliJson(['read', '8', '--json']);
    const msg208 = messages.find((m: any) => m.msg_id === 208);
    expect(msg208).toBeDefined();
    expect(msg208.text).toContain('[voice note');
    expect(msg208.text).toContain('Hola, te veo mañana para la reunión.');
  });

  it('indexes transcripts in sidecar index and matches Spanish queries accent-insensitively', async () => {
    // Build index with INDEX_ENABLED=true
    await cli(['index', 'build'], { INDEX_ENABLED: 'true' });

    // Search for "manana" without accent to match "mañana"
    const searchNoAccent = await cliJson(['search', 'manana', '--json'], { INDEX_ENABLED: 'true' });
    expect(searchNoAccent.length).toBeGreaterThanOrEqual(1);
    const foundMsg = searchNoAccent.find((m: any) => m.msg_id === 208);
    expect(foundMsg).toBeDefined();

    // Search for "reunion" without accent to match "reunión"
    const searchReunion = await cliJson(['search', 'reunion', '--json'], { INDEX_ENABLED: 'true' });
    expect(searchReunion.find((m: any) => m.msg_id === 208)).toBeDefined();
  });

  // Real-engine test: skipped unless real whisper-cli is installed
  const hasRealWhisper = fs.existsSync('/opt/homebrew/bin/whisper-cli') || fs.existsSync('/usr/local/bin/whisper-cli');
  const hasModel = fs.existsSync(path.expanduser ? path.expanduser('~/.imessage-mcp/models/ggml-tiny.bin') : path.join(os.homedir(), '.imessage-mcp/models/ggml-tiny.bin'))
    || fs.existsSync(path.join(os.homedir(), '.imessage-mcp/models/ggml-large-v3-turbo-q5_0.bin'));

  const realIt = (hasRealWhisper && hasModel) ? it : it.skip;

  realIt('transcribes authentic Spanish audio clip using real whisper.cpp engine', async () => {
    const spanishClip = path.resolve(__dirname, 'fixtures/spanish_sample.caf');
    const modelPath = fs.existsSync(path.join(os.homedir(), '.imessage-mcp/models/ggml-large-v3-turbo-q5_0.bin'))
      ? path.join(os.homedir(), '.imessage-mcp/models/ggml-large-v3-turbo-q5_0.bin')
      : path.join(os.homedir(), '.imessage-mcp/models/ggml-tiny.bin');

    const payload = await cliJson(['attachment', '--path', spanishClip, '--json'], {
      TRANSCRIBE_WHISPER_BIN: '/opt/homebrew/bin/whisper-cli',
      TRANSCRIBE_MODEL_PATH: modelPath,
      IMESSAGE_MCP_DIR: path.join(TEST_DIR, 'real_whisper_cache'),
    });

    expect(payload.is_audio).toBe(true);
    expect(payload.transcription_status).toBe('ok');
    expect(payload.transcription_source).toBe('whisper');
    expect(payload.language).toBe('es');
    expect(payload.transcription.toLowerCase()).toMatch(/hola|mañana|reunión|veo/);
  }, 30000);
});
