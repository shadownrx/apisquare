import axios from 'axios';
import { createClient } from '@vercel/kv';
import { BTN, formatDateAR } from './booking-copy';
import type { WaitlistEntry } from './types';

type KV = ReturnType<typeof createClient>;

function getKV(): KV | null {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return createClient({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
  }
  return null;
}

function localStore(): Map<string, WaitlistEntry[]> {
  const g = global as any;
  if (!g._localWaitlist) g._localWaitlist = new Map<string, WaitlistEntry[]>();
  return g._localWaitlist;
}

function indexKey(profesional: string, fecha: string) {
  return `espera:${profesional}:${fecha}`;
}

function entryKey(id: string) {
  return `espera:id:${id}`;
}

function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function readIndex(kv: KV | null, profesional: string, fecha: string): Promise<WaitlistEntry[]> {
  const key = indexKey(profesional, fecha);
  if (kv) {
    const raw = await kv.get(key);
    if (!raw) return [];
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }
  return [...(localStore().get(key) || [])];
}

async function writeIndex(kv: KV | null, profesional: string, fecha: string, entries: WaitlistEntry[]) {
  const key = indexKey(profesional, fecha);
  if (kv) {
    if (entries.length === 0) {
      await kv.del(key);
    } else {
      await kv.set(key, JSON.stringify(entries), { ex: 86400 * 45 });
    }
    return;
  }
  if (entries.length === 0) localStore().delete(key);
  else localStore().set(key, entries);
}

export async function joinWaitlist(input: {
  chatId: number;
  profesional: string;
  servicio: string;
  fecha: string;
}): Promise<{ ok: true; entry: WaitlistEntry; already: boolean } | { ok: false; reason: string }> {
  const kv = getKV();
  const existing = await readIndex(kv, input.profesional, input.fecha);
  const dup = existing.find(
    e =>
      e.chatId === input.chatId &&
      e.servicio === input.servicio &&
      !e.notifiedAt
  );
  if (dup) {
    return { ok: true, entry: dup, already: true };
  }

  if (existing.filter(e => !e.notifiedAt).length >= 25) {
    return { ok: false, reason: 'La lista de espera para ese día está llena.' };
  }

  const entry: WaitlistEntry = {
    id: newId(),
    chatId: input.chatId,
    profesional: input.profesional,
    servicio: input.servicio,
    fecha: input.fecha,
    createdAt: Date.now(),
  };

  existing.push(entry);
  await writeIndex(kv, input.profesional, input.fecha, existing);

  if (kv) {
    await kv.set(entryKey(entry.id), JSON.stringify(entry), { ex: 86400 * 45 });
  }

  return { ok: true, entry, already: false };
}

export async function getWaitlistEntry(id: string): Promise<WaitlistEntry | null> {
  const kv = getKV();
  if (kv) {
    const raw = await kv.get(entryKey(id));
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  }
  for (const entries of localStore().values()) {
    const found = entries.find(e => e.id === id);
    if (found) return found;
  }
  return null;
}

async function sendWaitlistTelegram(
  chatId: number,
  text: string,
  keyboard: any[][]
) {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) return false;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: keyboard },
    });
    return true;
  } catch (error) {
    console.error(`Error enviando aviso de lista de espera a ${chatId}:`, error);
    return false;
  }
}

/**
 * Cuando se libera un turno: avisa a quienes esperaban ese profesional+fecha
 * si ahora hay hueco para su servicio.
 */
export async function notifyWaitlistForDay(
  profesional: string,
  fecha: string,
  getLibres: (servicio: string) => Promise<string[]>
): Promise<{ notified: number }> {
  const kv = getKV();
  const entries = await readIndex(kv, profesional, fecha);
  const pending = entries.filter(e => !e.notifiedAt);
  if (pending.length === 0) return { notified: 0 };

  let notified = 0;
  const remaining: WaitlistEntry[] = [];

  for (const entry of entries) {
    if (entry.notifiedAt) {
      remaining.push(entry);
      continue;
    }

    const libres = await getLibres(entry.servicio);
    if (libres.length === 0) {
      remaining.push(entry);
      continue;
    }

    const sent = await sendWaitlistTelegram(
      entry.chatId,
      `✨ *Se liberó un turno*\n\n` +
        `Hay lugar el *${formatDateAR(fecha)}* con *${profesional}* ` +
        `para *${entry.servicio}*.\n\n` +
        `Horarios libres: *${libres.slice(0, 4).join('*, *')}*` +
        (libres.length > 4 ? '…' : '') +
        `\n\nTocá para ver los horarios y reservar:`,
      [
        [{ text: '📅 Ver horarios y reservar', callback_data: `wl_open:${entry.id}` }],
        [BTN.MENU],
      ]
    );

    if (sent) {
      notified += 1;
      const updated = { ...entry, notifiedAt: Date.now() };
      if (kv) {
        await kv.set(entryKey(entry.id), JSON.stringify(updated), { ex: 86400 * 7 });
      }
      // No lo dejamos en el índice activo (ya fue avisado)
    } else {
      remaining.push(entry);
    }
  }

  await writeIndex(kv, profesional, fecha, remaining.filter(e => !e.notifiedAt));
  return { notified };
}
