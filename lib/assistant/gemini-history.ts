import { createClient } from '@vercel/kv';
import type { Content } from '@google/generative-ai';

/** Pares user+model a conservar (N turnos ≈ 2N mensajes). */
export const GEMINI_MAX_TURNS = Number(process.env.GEMINI_HISTORY_MAX_TURNS || 12);

const CHAT_HISTORY_TTL = 60 * 60 * 24 * 7;
const memoryBySession = new Map<string, Content[]>();

function kvClient() {
  const url = process.env.KV_REST_API_URL?.trim();
  const token = process.env.KV_REST_API_TOKEN?.trim();
  if (!url || !token) return null;
  return createClient({ url, token });
}

function storageKey(sessionId: string) {
  return `gemini:chat:${sessionId}`;
}

function parseContents(raw: unknown): Content[] {
  if (!raw) return [];
  const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return Array.isArray(arr) ? (arr as Content[]) : [];
}

/** Recorta a los últimos N turnos y deja el historial empezando en user. */
export function trimGeminiHistory(history: Content[], maxTurns = GEMINI_MAX_TURNS): Content[] {
  const maxMessages = Math.max(2, maxTurns * 2);
  let trimmed = history.slice(-maxMessages);
  while (trimmed.length > 0 && trimmed[0].role !== 'user') {
    trimmed = trimmed.slice(1);
  }
  return trimmed;
}

export async function getGeminiHistory(sessionId: string): Promise<Content[]> {
  const sid = String(sessionId);
  const cached = memoryBySession.get(sid);
  if (cached) return cached;

  const kv = kvClient();
  if (kv) {
    try {
      const stored = await kv.get(storageKey(sid));
      const history = trimGeminiHistory(parseContents(stored));
      memoryBySession.set(sid, history);
      return history;
    } catch (e) {
      console.error('[gemini-history] get error:', e);
    }
  }

  return [];
}

export async function setGeminiHistory(sessionId: string, history: Content[]): Promise<void> {
  const sid = String(sessionId);
  const trimmed = trimGeminiHistory(history);
  memoryBySession.set(sid, trimmed);

  const kv = kvClient();
  if (kv) {
    try {
      await kv.set(storageKey(sid), JSON.stringify(trimmed), { ex: CHAT_HISTORY_TTL });
    } catch (e) {
      console.error('[gemini-history] set error:', e);
    }
  }
}

/** Agrega un turno user al historial de esa sesión (antes del API call). */
export async function appendGeminiUserTurn(sessionId: string, text: string): Promise<void> {
  const history = await getGeminiHistory(sessionId);
  history.push({ role: 'user', parts: [{ text }] });
  await setGeminiHistory(sessionId, history);
}

/** Reemplaza el historial con el que devolvió startChat (incluye user + model + tools). */
export async function replaceGeminiHistoryFromChat(
  sessionId: string,
  chatHistory: Content[]
): Promise<void> {
  await setGeminiHistory(sessionId, chatHistory);
}

export async function clearGeminiHistory(sessionId: string): Promise<void> {
  const sid = String(sessionId);
  memoryBySession.delete(sid);
  const kv = kvClient();
  if (kv) {
    try {
      await kv.del(storageKey(sid));
    } catch {
      /* ignore */
    }
  }
}
