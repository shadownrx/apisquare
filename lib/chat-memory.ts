import type { ChatMessage } from './types';

const MAX_CHAT_HISTORY = 10;
const CHAT_HISTORY_TTL = 60 * 60 * 24 * 7;

const localChatHistory = new Map<number, ChatMessage[]>();

function parseMessages(raw: unknown): ChatMessage[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : JSON.parse(raw as string);
  return Array.isArray(arr) ? arr : [];
}

export async function getChatHistory(
  chatId: number,
  kv: { get: (key: string) => Promise<unknown>; set: (key: string, value: string, opts?: { ex: number }) => Promise<unknown> } | null
): Promise<ChatMessage[]> {
  const key = `chat:${chatId}:history`;

  if (kv) {
    const stored = await kv.get(key);
    return parseMessages(stored);
  }

  return localChatHistory.get(chatId) || [];
}

export async function appendChatMessage(
  chatId: number,
  role: ChatMessage['role'],
  content: string,
  kv: { get: (key: string) => Promise<unknown>; set: (key: string, value: string, opts?: { ex: number }) => Promise<unknown> } | null
): Promise<void> {
  const trimmed = content.trim();
  if (!trimmed) return;

  const key = `chat:${chatId}:history`;
  const history = await getChatHistory(chatId, kv);
  history.push({ role, content: trimmed.slice(0, 500), ts: Date.now() });

  const trimmedHistory = history.slice(-MAX_CHAT_HISTORY);

  if (kv) {
    await kv.set(key, JSON.stringify(trimmedHistory), { ex: CHAT_HISTORY_TTL });
  } else {
    localChatHistory.set(chatId, trimmedHistory);
  }
}

export function formatChatHistoryForPrompt(messages: ChatMessage[]): string {
  if (messages.length === 0) return '';

  const lines = messages.map((message) => {
    const speaker = message.role === 'user' ? 'Usuario' : 'Asistente';
    return `${speaker}: ${message.content}`;
  });

  return `Historial reciente de la conversación:\n${lines.join('\n')}\n`;
}
