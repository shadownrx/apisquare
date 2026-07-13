import axios from 'axios';
import { createClient } from '@vercel/kv';
import { getLocalReservations } from '@/app/api/admin/reservations/route';
import { getAppointmentDate } from './googleCalendar';
import { BTN, buildBookingCard, formatDateAR } from './booking-copy';
import type { Reservation } from './types';

async function sendTelegramReminder(chatId: number, text: string, reservationId: string) {
  const token = process.env.TELEGRAM_TOKEN;
  if (!token) return false;

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔄 Cambiar turno', callback_data: `reprogramar:${reservationId}` },
            { text: '❌ Cancelar', callback_data: `confirmar_eliminar:${reservationId}` },
          ],
          [BTN.MIS_RESERVAS],
          [BTN.MENU],
        ],
      },
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

  const userKey = `user:${reservation.chatId}:reservas`;
  const userReservas = (await kv.get(userKey)) || [];
  let reservasArray = Array.isArray(userReservas) ? userReservas : JSON.parse(userReservas as string);
  reservasArray = reservasArray.map((r: Reservation) => (r.id === reservation.id ? reservation : r));
  await kv.set(userKey, JSON.stringify(reservasArray));
}

function buildReminderCard(reservation: Reservation): string {
  return buildBookingCard({
    profesional: reservation.profesional,
    servicio: reservation.servicio,
    nombre: reservation.nombre,
    fecha: reservation.fecha,
    hora: reservation.hora,
  });
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

    // Ventana amplia: desde 24h hasta ~12h antes (cubre crons poco frecuentes)
    if (!reservation.reminder24hSent && minutesUntil <= 24 * 60 && minutesUntil > 90) {
      const whenLabel =
        minutesUntil >= 20 * 60
          ? `mañana (${formatDateAR(reservation.fecha)})`
          : `el ${formatDateAR(reservation.fecha)}`;

      const sent = await sendTelegramReminder(
        reservation.chatId,
        `🔔 *Recordatorio de turno*\n\n` +
          `Te recordamos que ${whenLabel} tenés tu turno:\n\n` +
          `${buildReminderCard(reservation)}\n\n` +
          `Si necesitás, podés *cambiar* o *cancelar* desde acá.`,
        reservation.id
      );

      if (sent) {
        reservation.reminder24hSent = true;
        if (kv) await persistReservation(kv, reservation);
        sent24h += 1;
      }
    }

    // Ventana 1h: desde 90 min hasta 30 min antes
    if (!reservation.reminder1hSent && minutesUntil <= 90 && minutesUntil >= 30) {
      const mins = Math.round(minutesUntil);
      const sent = await sendTelegramReminder(
        reservation.chatId,
        `⏰ *Tu turno es pronto*\n\n` +
          `En unos *${mins} minutos* te esperamos:\n\n` +
          `${buildReminderCard(reservation)}\n\n` +
          `¡Nos vemos en la clínica!`,
        reservation.id
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
