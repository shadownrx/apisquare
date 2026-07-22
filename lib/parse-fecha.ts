/** Zona horaria de la clínica (Argentina no tiene DST). */
export const CLINIC_TZ = 'America/Argentina/Buenos_Aires';

/** ART = UTC-3 todo el año (sin DST). En minutos relativos a UTC. */
export const ART_UTC_OFFSET_MINUTES = -3 * 60;

export function toDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Fecha de calendario YYYY-MM-DD en Argentina.
 * Vercel corre en UTC: offset fijo UTC-3 (Argentina sin DST).
 */
export function getTodayStr(nowMs: number = Date.now()): string {
  const artInstant = new Date(nowMs + ART_UTC_OFFSET_MINUTES * 60 * 1000);
  return artInstant.toISOString().slice(0, 10);
}

export function getToday(nowMs: number = Date.now()): Date {
  const [y, m, d] = getTodayStr(nowMs).split('-').map(Number);
  return new Date(y, m - 1, d);
}

/**
 * Minutos desde medianoche en Argentina.
 * NUNCA usar getHours()/getUTCHours() crudos del server (UTC en Vercel = +3h).
 */
export function getNowMinutesInArgentina(nowMs: number = Date.now()): number {
  const artInstant = new Date(nowMs + ART_UTC_OFFSET_MINUTES * 60 * 1000);
  return artInstant.getUTCHours() * 60 + artInstant.getUTCMinutes();
}

export function dayOfWeekFromFechaStr(fechaStr: string): number {
  const [y, m, d] = fechaStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, 12, 0, 0)).getUTCDay();
}

export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function normalizeFechaText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    // conservar / y - para ISO (2026-07-13) y dd/mm
    .replace(/[^\p{L}\p{N}\s/-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Interpreta fechas sueltas o en frase: "hoy", "Tienes para hoy?", "mañana a la tarde".
 */
export function parseFecha(text: string): string | null {
  const normalized = normalizeFechaText(text);
  if (!normalized) return null;

  const today = getToday();
  const todayStr = toDateStr(today);

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;

  if (/^\d{1,2}\/\d{1,2}(?:\/\d{4})?$/.test(normalized)) {
    const m = normalized.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
    if (m) {
      const day = parseInt(m[1], 10);
      const month = parseInt(m[2], 10);
      const year = m[3] ? parseInt(m[3], 10) : today.getFullYear();
      const d = new Date(year, month - 1, day);
      if (!isNaN(d.getTime())) return toDateStr(d);
    }
  }

  if (
    normalized === 'pasado manana' ||
    normalized.includes('pasado manana') ||
    normalized.includes('pasadomanana')
  ) {
    return toDateStr(addDays(today, 2));
  }

  if (
    normalized === 'hoy' ||
    normalized === 'today' ||
    /(^|\s)hoy(\s|$)/.test(normalized) ||
    normalized.includes('para hoy') ||
    normalized.includes('de hoy') ||
    normalized.includes('hoy mismo')
  ) {
    return todayStr;
  }

  // Franja "por/a/de la mañana" ≠ fecha "mañana".
  // Ojo: "las 11 de mañana" = mañana (día), NO franja. Solo "de la mañana" es franja.
  const withoutMorningBand = normalized
    .replace(/\b(por|a|de|x)\s+la\s+manana\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (
    withoutMorningBand === 'manana' ||
    withoutMorningBand === 'tomorrow' ||
    /(^|\s)manana(\s|$)/.test(withoutMorningBand) ||
    withoutMorningBand.includes('para manana') ||
    withoutMorningBand.includes('manana mismo')
  ) {
    return toDateStr(addDays(today, 1));
  }

  const slashEmbed = normalized.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\b/);
  if (slashEmbed) {
    const day = parseInt(slashEmbed[1], 10);
    const month = parseInt(slashEmbed[2], 10);
    const year = slashEmbed[3] ? parseInt(slashEmbed[3], 10) : today.getFullYear();
    const d = new Date(year, month - 1, day);
    if (!isNaN(d.getTime())) return toDateStr(d);
  }

  // "20 de julio", "el lunes 20 de julio", "para el 20 de julio de 2026"
  const MONTHS: Record<string, number> = {
    enero: 0,
    febrero: 1,
    marzo: 2,
    abril: 3,
    mayo: 4,
    junio: 5,
    julio: 6,
    agosto: 7,
    septiembre: 8,
    setiembre: 8,
    octubre: 9,
    noviembre: 10,
    diciembre: 11,
  };
  const dayMonth = normalized.match(
    /\b(?:el\s+)?(\d{1,2})\s+de\s+(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)(?:\s+de\s+(\d{4}))?\b/
  );
  if (dayMonth) {
    const day = parseInt(dayMonth[1], 10);
    const month = MONTHS[dayMonth[2]];
    let year = dayMonth[3] ? parseInt(dayMonth[3], 10) : today.getFullYear();
    let d = new Date(year, month, day);
    if (!dayMonth[3] && d < today) {
      d = new Date(year + 1, month, day);
    }
    if (d.getDate() === day && d.getMonth() === month) return toDateStr(d);
  }

  // "lunes 20", "el lunes 21" (si el número no calza con el día, gana el weekday)
  const weekdays = [
    'domingo',
    'lunes',
    'martes',
    'miercoles',
    'jueves',
    'viernes',
    'sabado',
  ] as const;
  const wdMatch = normalized.match(
    /\b(domingo|lunes|martes|miercoles|jueves|viernes|sabado)\s*(\d{1,2})?\b/
  );
  if (wdMatch) {
    const targetWd = weekdays.indexOf(wdMatch[1] as (typeof weekdays)[number]);
    if (wdMatch[2]) {
      const dayNum = parseInt(wdMatch[2], 10);
      for (let monthOffset = 0; monthOffset <= 1; monthOffset++) {
        const candidate = new Date(today.getFullYear(), today.getMonth() + monthOffset, dayNum);
        if (candidate.getDate() === dayNum && candidate.getDay() === targetWd) {
          if (candidate >= today || toDateStr(candidate) === todayStr) {
            return toDateStr(candidate);
          }
        }
      }
    }
    let delta = (targetWd - today.getDay() + 7) % 7;
    if (delta === 0 && !/(^|\s)hoy(\s|$)/.test(normalized)) delta = 7;
    return toDateStr(addDays(today, delta === 0 ? 0 : delta));
  }

  // "el 19" / "para el 19" / "día 19" (día del mes actual o próximo)
  const dayOnly = normalized.match(/\b(?:el|dia|para el)\s+(\d{1,2})\b/);
  if (dayOnly) {
    const dayNum = parseInt(dayOnly[1], 10);
    if (dayNum >= 1 && dayNum <= 31) {
      let candidate = new Date(today.getFullYear(), today.getMonth(), dayNum);
      if (candidate < today) {
        candidate = new Date(today.getFullYear(), today.getMonth() + 1, dayNum);
      }
      if (candidate.getDate() === dayNum) return toDateStr(candidate);
    }
  }

  return null;
}
