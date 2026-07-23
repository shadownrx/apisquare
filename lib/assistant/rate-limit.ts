import { createClient } from '@vercel/kv';

/** Máx. mensajes de texto libre que pueden ir a Gemini por chatId / ventana. */
export const GEMINI_RATE_LIMIT_MAX = 10;
export const GEMINI_RATE_LIMIT_WINDOW_MS = 60_000;

const memoryBuckets = new Map<string, number[]>();

function kvClient() {
  const url = process.env.KV_REST_API_URL?.trim();
  const token = process.env.KV_REST_API_TOKEN?.trim();
  if (!url || !token) return null;
  return createClient({ url, token });
}

function storageKey(chatId: number | string) {
  return `gemini:rl:${chatId}`;
}

function prune(stamps: number[], now: number): number[] {
  return stamps.filter(t => now - t < GEMINI_RATE_LIMIT_WINDOW_MS);
}

/**
 * Consume 1 slot de la ventana. Si no hay cupo → allowed:false (usar reglas, no Gemini).
 * Memoria local + KV cuando hay credenciales (multi-instancia en Vercel).
 */
export async function consumeGeminiRateLimit(
  chatId: number | string
): Promise<{ allowed: boolean; remaining: number; count: number }> {
  const sid = String(chatId);
  const now = Date.now();
  const key = storageKey(sid);

  let stamps = prune(memoryBuckets.get(sid) || [], now);

  const kv = kvClient();
  if (kv) {
    try {
      const stored = await kv.get(key);
      const fromKv = Array.isArray(stored)
        ? (stored as number[])
        : typeof stored === 'string'
          ? (JSON.parse(stored) as number[])
          : [];
      if (Array.isArray(fromKv)) {
        const merged = prune([...stamps, ...fromKv], now);
        stamps = [...new Set(merged)].sort((a, b) => a - b);
      }
    } catch (e) {
      console.warn('[gemini-rate-limit] kv get error:', e);
    }
  }

  if (stamps.length >= GEMINI_RATE_LIMIT_MAX) {
    memoryBuckets.set(sid, stamps);
    return { allowed: false, remaining: 0, count: stamps.length };
  }

  stamps.push(now);
  memoryBuckets.set(sid, stamps);

  if (kv) {
    try {
      await kv.set(key, JSON.stringify(stamps), {
        ex: Math.ceil(GEMINI_RATE_LIMIT_WINDOW_MS / 1000),
      });
    } catch (e) {
      console.warn('[gemini-rate-limit] kv set error:', e);
    }
  }

  return {
    allowed: true,
    remaining: Math.max(0, GEMINI_RATE_LIMIT_MAX - stamps.length),
    count: stamps.length,
  };
}

/** Solo tests: limpia el bucket en memoria. */
export function resetGeminiRateLimitForTests(chatId?: number | string) {
  if (chatId === undefined) memoryBuckets.clear();
  else memoryBuckets.delete(String(chatId));
}
