import { addDays, getToday, getTodayStr, toDateStr } from './parse-fecha';
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

export function buildLocationMessage(): string {
  return (
    `📍 *Dónde estamos*\n\n` +
    `${getClinicAddress()}\n\n` +
    `[Ver en el mapa](${getClinicMapsUrl()})`
  );
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

  const nombreSafe =
    opts.nombre &&
    opts.nombre.trim() &&
    opts.nombre.trim().toLowerCase() !== 'undefined' &&
    opts.nombre.trim().toLowerCase() !== 'null'
      ? opts.nombre.trim()
      : '—';

  lines.push(`👤 *Nombre:* ${nombreSafe}`);
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

/** Chatbot: sin "Paso X/Y" — el cuerpo va solo. */
export function withFlowProgress(_paso: string | null | undefined, body: string): string {
  return body;
}

export function getFlowProgressMeta(
  estado: ConversationState
): { current: number; total: number; label: string } | null {
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
  REBOOK_LAST: { text: '🔁 Repetir último turno', callback_data: 'rebook_last' },
} as const;

export function buildRebookButton(profesional: string, servicio: string) {
  const shortProf = profesional.split(' ')[0];
  const shortServ = servicio.length > 18 ? `${servicio.slice(0, 16)}…` : servicio;
  const label = `🔁 ${shortProf} · ${shortServ}`;
  return {
    text: label.length > 64 ? '🔁 Repetir último turno' : label,
    callback_data: 'rebook_last',
  };
}

export function buildLimitReachedMessage(max: number): string {
  return (
    `Ya tenés el máximo de *${max} turnos* activos.\n\n` +
    `Si necesitás otro, cancelá o reprogramá uno desde *Mis reservas*.`
  );
}

export function buildFeriadoMessage(fechaLabel: string): string {
  return `❌ El *${fechaLabel}* es feriado / no hay atención. Elegí otro día:`;
}

/**
 * Copy corto y escaneable para cupos (Telegram Markdown).
 * Los botones llevan servicios/horarios; el texto no los repite.
 */
export function buildAvailabilityPatientMessage(opts: {
  fechaLabel: string;
  needServiceChoice?: boolean;
  empty?: boolean;
  feriado?: boolean;
  recommendation?: { hora: string; profesional: string; servicio?: string } | null;
  horaPedida?: string | null;
  requestedHoraAvailable?: boolean | null;
}): string {
  const fecha = opts.fechaLabel;
  if (opts.feriado || opts.empty) {
    return `Para el *${fecha}* no tengo cupos libres.\n\n¿Probamos otro día?`;
  }

  const horaMiss =
    opts.horaPedida &&
    opts.requestedHoraAvailable === false
      ? `Para *${fecha}* no hay exactamente a las *${opts.horaPedida}*, pero sí hay lugar.`
      : `Para *${fecha}* hay lugar.`;

  if (opts.needServiceChoice) {
    return `${horaMiss}\n\nTocá el servicio que querés 👇`;
  }

  if (opts.recommendation) {
    const r = opts.recommendation;
    const who = shortProfName(r.profesional);
    return (
      `${horaMiss}\n` +
      `• Por ejemplo *${r.hora}* con *${who}*\n\n` +
      `Elegí un horario 👇`
    );
  }

  return `${horaMiss}\n\nElegí un horario o decime a qué hora te viene 👇`;
}

export function buildFaqPagoMessage(): string {
  return (
    '💳 *Medios de pago*\n\n' +
    'Aceptamos *efectivo*, *transferencia* y *Mercado Pago* en el consultorio.\n\n' +
    '*(Atención particular, sin obra social)*'
  );
}

export function buildFaqCancelacionMessage(): string {
  return (
    '🔄 *Cambios y cancelaciones*\n\n' +
    'Podés cambiar o cancelar tu turno desde *Mis reservas*.\n' +
    'Si es con poca anticipación, avisanos lo antes posible.'
  );
}

export function buildFaqQueTraerMessage(): string {
  return (
    '🎒 *Qué traer*\n\n' +
    '• Ropa cómoda\n' +
    '• Llegar unos minutos antes\n\n' +
    'No hace falta orden médica.'
  );
}

export function buildFaqEstacionamientoMessage(): string {
  return (
    '🅿️ *Estacionamiento*\n\n' +
    `Hay lugar para estacionar en la zona de ${getClinicAddress()}.`
  );
}

export function buildFaqDuracionMessage(
  servicios?: Array<{ nombre: string; duracionMinutos: number }>
): string {
  if (!servicios?.length) {
    return '⏱ Las sesiones suelen durar entre 25 y 60 minutos según el servicio.';
  }
  const list = servicios.map(s => `• *${s.nombre}*: ${s.duracionMinutos} min`).join('\n');
  return `⏱ *Duración de las sesiones*\n\n${list}`;
}

/** Etiqueta cercana: hoy / mañana / fecha completa. */
export function formatFechaRelativaAR(fechaStr: string, nowMs: number = Date.now()): string {
  const today = getTodayStr(nowMs);
  if (fechaStr === today) return 'hoy';
  if (fechaStr === toDateStr(addDays(getToday(nowMs), 1))) return 'mañana';
  return formatDateAR(fechaStr);
}

function shortProfName(profesional: string): string {
  return profesional.trim().split(/\s+/)[0] || profesional;
}

/** Minutos hasta el inicio del turno (Argentina UTC-3). Negativo = ya pasó. */
export function minutesUntilAppointment(
  fecha: string,
  hora: string,
  nowMs: number = Date.now()
): number {
  const startDt = new Date(`${fecha}T${hora}:00-03:00`);
  return Math.round((startDt.getTime() - nowMs) / 60000);
}

export function formatTimeUntilLabel(minutes: number): string {
  if (minutes <= 0) return 'ya pasó o es ahora';
  if (minutes < 60) return `faltan ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  if (hours < 48) {
    return rem === 0 ? `faltan ${hours} h` : `faltan ${hours} h ${rem} min`;
  }
  const days = Math.floor(hours / 24);
  const hoursLeft = hours % 24;
  if (hoursLeft === 0) return `faltan ${days} día${days === 1 ? '' : 's'}`;
  return `faltan ${days} día${days === 1 ? '' : 's'} y ${hoursLeft} h`;
}

/** Estado del turno en lenguaje natural + CTA cambiar/cancelar. */
export function buildTurnoStatusMessage(
  futuras: Reservation[],
  opts?: { pastCount?: number; nowMs?: number; focus?: 'status' | 'time_until' }
): string {
  const pastCount = opts?.pastCount ?? 0;
  const nowMs = opts?.nowMs ?? Date.now();
  const focus = opts?.focus ?? 'status';

  if (futuras.length === 0) {
    return pastCount > 0
      ? 'No tenés turnos próximos. ¿Querés reservar uno nuevo?'
      : 'Todavía no tenés reservas. ¿Querés hacer una?';
  }

  const sorted = [...futuras].sort((a, b) =>
    `${a.fecha}T${a.hora}`.localeCompare(`${b.fecha}T${b.hora}`)
  );

  if (sorted.length === 1) {
    const r = sorted[0];
    const cuando = formatFechaRelativaAR(r.fecha, nowMs);
    const fechaExtra = cuando === 'hoy' || cuando === 'mañana' ? ` (${formatDateShort(r.fecha)})` : '';
    const mins = minutesUntilAppointment(r.fecha, r.hora, nowMs);
    const timeLabel = formatTimeUntilLabel(mins);

    if (focus === 'time_until') {
      return (
        `Tu turno es *${cuando}*${fechaExtra} a las *${r.hora}* ` +
        `(*${r.servicio}* con *${shortProfName(r.profesional)}*).\n\n` +
        `⏱ *${timeLabel.charAt(0).toUpperCase() + timeLabel.slice(1)}*.`
      );
    }

    return (
      `📅 *Tu turno*\n\n` +
      `Tenés turno *${cuando}*${fechaExtra} a las *${r.hora}*: ` +
      `*${r.servicio}* con *${shortProfName(r.profesional)}*.\n\n` +
      `⏱ ${timeLabel.charAt(0).toUpperCase() + timeLabel.slice(1)}.\n\n` +
      `¿Lo cambiás o lo cancelás?`
    );
  }

  const next = sorted[0];
  const nextMins = minutesUntilAppointment(next.fecha, next.hora, nowMs);
  const nextTime = formatTimeUntilLabel(nextMins);

  if (focus === 'time_until') {
    const cuando = formatFechaRelativaAR(next.fecha, nowMs);
    return (
      `Tu próximo turno es *${cuando}* a las *${next.hora}* ` +
      `(*${next.servicio}* con *${shortProfName(next.profesional)}*).\n\n` +
      `⏱ *${nextTime.charAt(0).toUpperCase() + nextTime.slice(1)}*.\n\n` +
      `Tenés *${sorted.length} turnos* en total.`
    );
  }

  const lines = sorted.map((r, i) => {
    const cuando = formatFechaRelativaAR(r.fecha, nowMs);
    return `${i + 1}. *${cuando}* a las *${r.hora}* — ${r.servicio} con ${shortProfName(r.profesional)}`;
  });

  return (
    `📅 *Tus turnos*\n\n` +
    `Tenés *${sorted.length} turnos* próximos:\n\n` +
    `${lines.join('\n')}\n\n` +
    `⏱ El más cercano: ${nextTime}.\n\n` +
    `¿Querés cambiar o cancelar alguno?` +
    (pastCount > 0
      ? `\n\n_(${pastCount} turno${pastCount > 1 ? 's' : ''} pasado${pastCount > 1 ? 's' : ''} oculto${pastCount > 1 ? 's' : ''})_`
      : '')
  );
}
