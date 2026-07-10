import axios from 'axios';
import { createClient } from '@vercel/kv';
import { getLocalReservations } from '@/app/api/admin/reservations/route';
import { getAppointmentDate } from './googleCalendar';
import type { Reservation } from './types';

function formatDate(fechaStr: string): string {
  const fecha = new Date(fechaStr + 'T12:00:00');
  return fecha.toLocaleDateString('es-AR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

async function sendTelegramReminder(chatId: number, text: string) {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) return false;

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    });
    return true;
  } catch (error) {
    console.error(`Error enviando recordatorio a ${chatId}:`, error);
    return false;
  }
}

async function persistReservation(
  kv: ReturnType<typeof createClient>,
  reservation: Reservation
) {
  const key = `reserva:${reservation.profesional}:${reservation.fecha}:${reservation.hora}`;
  const idKey = `reserva:id:${reservation.id}`;
  await kv.set(key, JSON.stringify(reservation), { ex: 86400 * 30 });
  await kv.set(idKey, JSON.stringify(reservation), { ex: 86400 * 30 });
}

export async function processReminders() {
  const kv =
    process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
      ? createClient({
          url: process.env.KV_REST_API_URL,
          token: process.env.KV_REST_API_TOKEN,
        })
      : null;

  const reservations: Reservation[] = [];

  if (kv) {
    const keys = await kv.keys('reserva:id:*');
    for (const key of keys) {
      const value = await kv.get(key);
      if (!value) continue;
      const reservation = typeof value === 'string' ? JSON.parse(value) : value;
      reservations.push(reservation);
    }
  } else {
    reservations.push(...getLocalReservations());
  }

  const now = Date.now();
  let sent24h = 0;
  let sent1h = 0;

  for (const reservation of reservations) {
    const appointmentAt = getAppointmentDate(reservation).getTime();
    const minutesUntil = (appointmentAt - now) / 60000;

    if (minutesUntil <= 0) continue;

    if (!reservation.reminder24hSent && minutesUntil <= 24 * 60 && minutesUntil >= 23 * 60) {
      const sent = await sendTelegramReminder(
        reservation.chatId,
        `🔔 *Recordatorio de turno*\n\n` +
          `Te recordamos que mañana tenés:\n` +
          `👨‍⚕️ ${reservation.profesional}\n` +
          `✨ *${reservation.servicio}*\n` +
          `📅 ${formatDate(reservation.fecha)}\n` +
          `🕐 ${reservation.hora}\n\n` +
          `Si necesitás cambiarlo, andá a *Mis reservas*.`
      );

      if (sent) {
        reservation.reminder24hSent = true;
        if (kv) await persistReservation(kv, reservation);
        sent24h += 1;
      }
    }

    if (!reservation.reminder1hSent && minutesUntil <= 75 && minutesUntil >= 45) {
      const sent = await sendTelegramReminder(
        reservation.chatId,
        `⏰ *Tu turno es pronto*\n\n` +
          `En aproximadamente 1 hora te esperamos:\n` +
          `👨‍⚕️ ${reservation.profesional}\n` +
          `✨ *${reservation.servicio}*\n` +
          `🕐 ${reservation.hora}\n\n` +
          `¡Nos vemos en la clínica!`
      );

      if (sent) {
        reservation.reminder1hSent = true;
        if (kv) await persistReservation(kv, reservation);
        sent1h += 1;
      }
    }
  }

  return { checked: reservations.length, sent24h, sent1h };
}
