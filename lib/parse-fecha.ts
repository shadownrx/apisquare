/** Zona horaria de la clínica (Argentina no tiene DST). */
export const CLINIC_TZ = 'America/Argentina/Buenos_Aires';

export function toDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Fecha de calendario YYYY-MM-DD en Argentina (Vercel corre en UTC). */
export function getTodayStr(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: CLINIC_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function getToday(): Date {
  const [y, m, d] = getTodayStr().split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Minutos desde medianoche en Argentina (para filtrar turnos ya pasados). */
export function getNowMinutesInArgentina(): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: CLINIC_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date());

  const hour = Number(parts.find(p => p.type === 'hour')?.value);
  const minute = Number(parts.find(p => p.type === 'minute')?.value);
  return hour * 60 + minute;
}

export function dayOfWeekFromFechaStr(fechaStr: string): number {
  const [y, m, d] = fechaStr.split('-').map(Number);
  // Mediodía local evita bordes de DST/UTC al calcular el día de la semana
  return new Date(y, m - 1, d, 12, 0, 0).getDay();
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function parseFecha(text: string): string | null {
  const normalized = text.toLowerCase().trim();
  const today = getToday();

  if (['hoy', 'today'].includes(normalized)) return toDateStr(today);
  if (['mañana', 'manana', 'tomorrow'].includes(normalized)) return toDateStr(addDays(today, 1));
  if (['pasado mañana', 'pasado manana'].includes(normalized)) return toDateStr(addDays(today, 2));

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;

  const slashMatch = normalized.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
  if (slashMatch) {
    const day = parseInt(slashMatch[1], 10);
    const month = parseInt(slashMatch[2], 10);
    const year = slashMatch[3] ? parseInt(slashMatch[3], 10) : today.getFullYear();
    const d = new Date(year, month - 1, day);
    if (!isNaN(d.getTime())) return toDateStr(d);
  }

  return null;
}
