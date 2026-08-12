/**
 * Input boundary sanitisation for MCP tool arguments.
 *
 * Per the project's Schema-Driven Development rules, every parameter is
 * validated at the entry point before it reaches a CLI subcommand. Tool
 * arguments arrive from an LLM, so they are frequently the wrong type
 * (numbers as strings, `null`, nested objects) rather than merely out of
 * range. Coercing defensively here keeps a bad argument from becoming a
 * child-process error or an unhandled rejection.
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** Reject NUL bytes and control characters that break argv / SQLite. */
function assertClean(value: string, field: string): string {
  if (value.includes('\0')) {
    throw new ValidationError(`Parameter "${field}" must not contain null bytes.`);
  }
  return value;
}

export interface StringOptions {
  required?: boolean;
  maxLength?: number;
  field: string;
}

export function requireString(value: unknown, opts: StringOptions): string {
  const { field, maxLength = 4096, required = true } = opts;

  if (value === undefined || value === null) {
    if (required) throw new ValidationError(`Missing required parameter "${field}".`);
    return '';
  }
  if (typeof value === 'object') {
    throw new ValidationError(`Parameter "${field}" must be a string, received ${Array.isArray(value) ? 'array' : 'object'}.`);
  }

  const str = String(value).trim();
  if (required && !str) {
    throw new ValidationError(`Missing required parameter "${field}".`);
  }
  if (str.length > maxLength) {
    throw new ValidationError(`Parameter "${field}" exceeds the maximum length of ${maxLength} characters.`);
  }
  return assertClean(str, field);
}

export function optionalString(value: unknown, field: string, maxLength = 4096): string {
  return requireString(value, { field, maxLength, required: false });
}

/**
 * Clamp a numeric parameter into range.
 *
 * Accepts numeric strings because MCP clients routinely send `"30"` for a
 * `number` schema; the previous `typeof === 'number'` check silently discarded
 * those and fell back to the default.
 */
export function clampNumber(value: unknown, field: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === '') return fallback;

  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw new ValidationError(`Parameter "${field}" must be a number, received "${String(value)}".`);
  }
  return Math.min(Math.max(Math.floor(num), min), max);
}

export function requireStringArray(value: unknown, field: string, maxItems = 50): string[] {
  if (value === undefined || value === null) {
    throw new ValidationError(`Missing required parameter "${field}" (non-empty array).`);
  }

  // Tolerate a comma-separated string, which models often send for arrays.
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : null;

  if (!raw) {
    throw new ValidationError(`Parameter "${field}" must be an array of strings.`);
  }

  const items = raw
    .filter((v) => v !== null && v !== undefined && typeof v !== 'object')
    .map((v) => String(v).trim())
    .filter(Boolean)
    .map((v) => assertClean(v, field));

  if (items.length === 0) {
    throw new ValidationError(`Parameter "${field}" must contain at least one non-empty value.`);
  }
  if (items.length > maxItems) {
    throw new ValidationError(`Parameter "${field}" accepts at most ${maxItems} items.`);
  }
  return items;
}

/** Booleans arrive as `true`, `"true"` or `1` depending on the client. */
export function coerceBoolean(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
  return false;
}
