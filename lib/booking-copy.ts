import type { ConversationState, Reservation } from './types';

export function formatPriceAR(precio: number): string {
  return `$${precio.toLocaleString('es-AR')}`;
}

export function formatDateAR(fechaStr: string): string {
  const fecha = new Date(fechaStr + 'T12:00:00');
  return fecha.toLocaleDateString('es-AR', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

export function formatDateShort(fechaStr: string): string {
  const fecha = new Date(fechaStr + 'T12:00:00');
  const weekday = fecha.toLocaleDateString('es-AR', { weekday: 'short' });
  const day = fecha.getDate();
  const month = fecha.toLocaleDateString('es-AR', { month: 'short' });
  return `${weekday.charAt(0).toUpperCase() + weekday.slice(1)} ${day} ${month.charAt(0).toUpperCase() + month.slice(1)}`;
}

export function horaAMinutos(horaStr: string): number {
  const [h, m] = horaStr.split(':').map(Number);
  return h * 60 + (m || 0);
}

export function minutosAHora(minutos: number): string {
  const h = Math.floor(minutos / 60)
    .toString()
    .padStart(2, '0');
  const m = (minutos % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

export function formatTimeRange(hora: string, duracionMinutos: number): string {
  const fin = minutosAHora(horaAMinutos(hora) + duracionMinutos);
  return `${hora}–${fin}`;
}

export function shortBookingCode(id: string): string {
  return id.slice(-6).toUpperCase();
}

export function capitalizeName(nombre: string): string {
  return nombre
    .trim()
    .split(/\s+/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

export function getClinicAddress(): string {
  return (
    process.env.CLINIC_ADDRESS?.trim() ||
    'Bernardo de Monteagudo 328, T4000 San Miguel de Tucumán, Tucumán'
  );
}

export function getClinicMapsUrl(): string {
  return (
    process.env.CLINIC_MAPS_URL?.trim() ||
    'https://www.google.com/maps/search/?api=1&query=Bernardo+de+Monteagudo+328,+San+Miguel+de+Tucum%C3%A1n,+Tucum%C3%A1n'
  );
}

export function getClinicFooter(): string {
  const address = getClinicAddress();
  const maps = getClinicMapsUrl();

  let block = '\n📍 *Ubicación*\n';
  if (address) block += `${address}\n`;
  if (maps) block += `[Ver en el mapa](${maps})\n`;
  return block;
}

export type ServiceSnapshot = {
  nombre: string;
  duracionMinutos: number;
  precio: number;
};

export function buildBookingCard(opts: {
  profesional: string;
  servicio: string;
  nombre: string;
  fecha: string;
  hora: string;
  duracionMinutos?: number;
  precio?: number;
  codigo?: string;
  includeDisclaimer?: boolean;
}): string {
  const lines = [
    `👨‍⚕️ *Profesional:* ${opts.profesional}`,
    `🩺 *Servicio:* ${opts.servicio}`,
  ];

  if (opts.duracionMinutos) {
    lines.push(`⏱ *Duración:* ${opts.duracionMinutos} min`);
  }
  if (typeof opts.precio === 'number') {
    lines.push(`💰 *Precio:* ${formatPriceAR(opts.precio)}`);
  }

  lines.push(`👤 *Nombre:* ${opts.nombre}`);
  lines.push(`📅 *Fecha:* ${formatDateAR(opts.fecha)}`);

  if (opts.duracionMinutos) {
    lines.push(`🕐 *Horario:* ${formatTimeRange(opts.hora, opts.duracionMinutos)}`);
  } else {
    lines.push(`🕐 *Hora:* ${opts.hora}`);
  }

  if (opts.codigo) {
    lines.push(`🔖 *Código:* \`${opts.codigo}\``);
  }

  let text = lines.join('\n');

  if (opts.includeDisclaimer) {
    text += '\n\n⚠️ Atención *particular* (sin obra social).';
  }

  text += getClinicFooter();
  return text;
}

export function buildSuccessMessage(
  reserva: Reservation,
  servicio?: ServiceSnapshot | null,
  isReschedule = false
): string {
  const codigo = shortBookingCode(reserva.id);
  const card = buildBookingCard({
    profesional: reserva.profesional,
    servicio: reserva.servicio,
    nombre: reserva.nombre,
    fecha: reserva.fecha,
    hora: reserva.hora,
    duracionMinutos: servicio?.duracionMinutos,
    precio: servicio?.precio,
    codigo,
    includeDisclaimer: true,
  });

  const title = isReschedule ? '🔄 *¡Turno reprogramado!*' : '🎉 *¡Reserva confirmada!*';
  return (
    `${title}\n\n` +
    `${card}\n\n` +
    `Te vamos a avisar *24 h* y *1 h* antes del turno.\n` +
    `Si necesitás cambiar algo, entrá a *Mis reservas*.\n\n` +
    `¡Te esperamos! 😊`
  );
}

const FLOW_STEPS: Array<{ paso: string; label: string }> = [
  { paso: 'profesional', label: 'Profesional' },
  { paso: 'servicio', label: 'Servicio' },
  { paso: 'nombre', label: 'Nombre' },
  { paso: 'fecha', label: 'Fecha' },
  { paso: 'hora', label: 'Horario' },
  { paso: 'confirmar', label: 'Confirmar' },
];

export function withFlowProgress(paso: string | null | undefined, body: string): string {
  if (!paso) return body;
  const idx = FLOW_STEPS.findIndex(s => s.paso === paso);
  if (idx < 0) return body;
  const total = FLOW_STEPS.length;
  const current = idx + 1;
  const label = FLOW_STEPS[idx].label;
  return `📍 *Paso ${current}/${total} · ${label}*\n\n${body}`;
}

export function getFlowProgressMeta(estado: ConversationState): { current: number; total: number; label: string } | null {
  if (!estado.paso) return null;
  const idx = FLOW_STEPS.findIndex(s => s.paso === estado.paso);
  if (idx < 0) return null;
  return { current: idx + 1, total: FLOW_STEPS.length, label: FLOW_STEPS[idx].label };
}

export const BTN = {
  MENU: { text: '🏠 Menú', callback_data: 'menu' },
  CANCEL_FLOW: { text: '❌ Cancelar', callback_data: 'menu' },
  MIS_RESERVAS: { text: '📋 Mis reservas', callback_data: 'misreservas' },
  RESERVAR: { text: '📅 Reservar turno', callback_data: 'reservar' },
} as const;
