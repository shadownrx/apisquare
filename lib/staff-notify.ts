import axios from 'axios';
import { formatDateAR, shortBookingCode } from './booking-copy';
import type { Reservation } from './types';

export type StaffNotifyEvent = 'created' | 'cancelled' | 'rescheduled';

function getStaffChatId(): string | null {
  const raw = process.env.STAFF_TELEGRAM_CHAT_ID?.trim();
  return raw || null;
}

function getTelegramToken(): string | null {
  const token = process.env.TELEGRAM_TOKEN?.trim();
  return token || null;
}

function buildStaffMessage(
  event: StaffNotifyEvent,
  reserva: Reservation,
  previous?: { fecha: string; hora: string }
): string {
  const codigo = shortBookingCode(reserva.id);
  const header =
    event === 'created'
      ? '🆕 *Nueva reserva*'
      : event === 'cancelled'
        ? '❌ *Reserva cancelada*'
        : '🔄 *Turno reprogramado*';

  const lines = [
    header,
    '',
    `👤 ${reserva.nombre}`,
    `👨‍⚕️ ${reserva.profesional}`,
    `🩺 ${reserva.servicio}`,
  ];

  if (event === 'rescheduled' && previous) {
    lines.push(
      `📅 Antes: ${formatDateAR(previous.fecha)} · ${previous.hora}`,
      `📅 Ahora: ${formatDateAR(reserva.fecha)} · ${reserva.hora}`
    );
  } else {
    lines.push(`📅 ${formatDateAR(reserva.fecha)} · ${reserva.hora}`);
  }

  lines.push(`🔖 \`${codigo}\``);
  lines.push(`🆔 chat \`${reserva.chatId}\``);

  return lines.join('\n');
}

/** Avisa al chat/grupo del staff si STAFF_TELEGRAM_CHAT_ID está configurado. */
export async function notifyStaff(
  event: StaffNotifyEvent,
  reserva: Reservation,
  previous?: { fecha: string; hora: string }
): Promise<void> {
  const chatId = getStaffChatId();
  const token = getTelegramToken();
  if (!chatId || !token) return;

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: buildStaffMessage(event, reserva, previous),
      parse_mode: 'Markdown',
      disable_web_page_preview: true,
    });
  } catch (error) {
    console.error('[staff-notify] Failed to notify staff:', error);
  }
}
