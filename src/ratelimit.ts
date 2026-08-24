import { Request } from 'express';

const WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILURES = 20;
// Hard cap on tracked IPs to bound memory under spoofed-IP floods.
const MAX_TRACKED_IPS = 10000;

const failuresByIp = new Map<string, number[]>();

/** Real client IP: Cloudflare header when tunneled, socket address otherwise. */
export function clientIp(req: Request): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf) return cf;
  return req.socket?.remoteAddress || 'unknown';
}

function recentFailures(ip: string, now: number): number[] {
  const timestamps = (failuresByIp.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  if (timestamps.length === 0) {
    failuresByIp.delete(ip);
  } else {
    failuresByIp.set(ip, timestamps);
  }
  return timestamps;
}

export function isRateLimited(req: Request): boolean {
  return recentFailures(clientIp(req), Date.now()).length >= MAX_FAILURES;
}

export function recordAuthFailure(req: Request): void {
  const now = Date.now();
  const ip = clientIp(req);
  if (!failuresByIp.has(ip) && failuresByIp.size >= MAX_TRACKED_IPS) {
    // Prune stale windows; recentFailures deletes empty entries as a side effect.
    for (const key of [...failuresByIp.keys()]) recentFailures(key, now);
    if (failuresByIp.size >= MAX_TRACKED_IPS) return;
  }
  failuresByIp.set(ip, [...recentFailures(ip, now), now]);
}
