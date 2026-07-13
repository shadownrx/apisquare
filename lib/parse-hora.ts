/** Extrae y resuelve horarios escritos a mano ("15:30", "15.30 o 16:30", "a las 18"). */

export type HoraParseResult =
  | { status: 'matched'; hora: string }
  | { status: 'ambiguous'; candidates: string[] }
  | { status: 'none' };

function padHora(h: number, m: number): string | null {
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Normaliza un token suelto a HH:MM si se puede. */
export function normalizeHoraToken(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(',', '.');

  let m = t.match(/^(\d{1,2})[:.\-](\d{2})$/);
  if (m) return padHora(parseInt(m[1], 10), parseInt(m[2], 10));

  m = t.match(/^(\d{3,4})$/);
  if (m) {
    const digits = m[1];
    if (digits.length === 3) {
      return padHora(parseInt(digits[0], 10), parseInt(digits.slice(1), 10));
    }
    return padHora(parseInt(digits.slice(0, 2), 10), parseInt(digits.slice(2), 10));
  }

  m = t.match(/^(\d{1,2})$/);
  if (m) return padHora(parseInt(m[1], 10), 0);

  return null;
}

export function extractHoraCandidates(text: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const push = (h: string | null) => {
    if (!h || seen.has(h)) return;
    seen.add(h);
    found.push(h);
  };

  for (const m of text.matchAll(/\b(\d{1,2})[:.\-](\d{2})\b/g)) {
    push(padHora(parseInt(m[1], 10), parseInt(m[2], 10)));
  }

  for (const m of text.matchAll(/\b(\d{1,2})\s+(\d{2})\b/g)) {
    const mins = parseInt(m[2], 10);
    if (mins <= 59) push(padHora(parseInt(m[1], 10), mins));
  }

  for (const m of text.matchAll(/\b(\d{3,4})\b/g)) {
    push(normalizeHoraToken(m[1]));
  }

  for (const m of text.matchAll(/\b(?:a\s+)?las?\s+(\d{1,2})\b/gi)) {
    push(padHora(parseInt(m[1], 10), 0));
  }

  // Hora suelta al final / sola: "a las 15", "15"
  if (/^\d{1,2}$/.test(text.trim())) {
    push(padHora(parseInt(text.trim(), 10), 0));
  }

  return found;
}

/** ¿El mensaje parece elegir/mencionar un horario? */
export function looksLikeHoraInput(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;

  const normalized = trimmed
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  if (
    ['manana', 'tarde', 'morning', 'afternoon', 'por la manana', 'por la tarde'].some(w =>
      normalized.includes(w)
    )
  ) {
    return true;
  }

  if (
    ['el primero', 'primero', 'cualquiera', 'al azar', 'da igual', 'me da igual'].some(w =>
      normalized.includes(w)
    )
  ) {
    return true;
  }

  if (/^\d{1,2}$/.test(trimmed)) return true;

  return extractHoraCandidates(trimmed).length > 0;
}

function matchCandidatesAgainstLibres(candidates: string[], horariosLibres: string[]): string[] {
  const matched: string[] = [];
  const seen = new Set<string>();

  const add = (h: string) => {
    if (!seen.has(h)) {
      seen.add(h);
      matched.push(h);
    }
  };

  for (const c of candidates) {
    if (horariosLibres.includes(c)) {
      add(c);
      continue;
    }
    // "15:00" / "a las 15" → todos los libres de esa hora (o el único)
    if (c.endsWith(':00')) {
      const hour = parseInt(c.split(':')[0], 10);
      const sameHour = horariosLibres.filter(h => parseInt(h.split(':')[0], 10) === hour);
      for (const h of sameHour) add(h);
    }
  }

  return matched;
}

/**
 * Resuelve el texto del usuario contra la lista de horarios libres.
 * - 1 match → matched
 * - varios ("15:30 o 16:30") → ambiguous
 * - "1"/"2" con pocos slots → índice 1-based
 * - "el primero" → primer libre
 */
export function parseHoraSelection(text: string, horariosLibres: string[]): HoraParseResult {
  if (!horariosLibres.length) return { status: 'none' };

  const trimmed = text.trim();
  const normalized = trimmed
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}\s:?]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (
    ['el primero', 'primero', 'cualquiera', 'al azar', 'da igual', 'me da igual', 'el que sea'].some(
      w => normalized === w || normalized.includes(w)
    )
  ) {
    return { status: 'matched', hora: horariosLibres[0] };
  }

  // Índice de lista solo si el mensaje es SOLO un número y no parece una hora de la tarde/noche típica
  // (1..N cuando N < 10, o siempre si el número no puede ser hora de agenda >= 8)
  if (/^\d{1,2}$/.test(trimmed)) {
    const num = parseInt(trimmed, 10);
    const asHour = padHora(num, 0);
    const hourMatches = asHour
      ? matchCandidatesAgainstLibres([asHour], horariosLibres)
      : [];

    if (num >= 1 && num <= horariosLibres.length && hourMatches.length === 0) {
      return { status: 'matched', hora: horariosLibres[num - 1] };
    }
    if (hourMatches.length === 1) {
      return { status: 'matched', hora: hourMatches[0] };
    }
    if (hourMatches.length > 1) {
      return { status: 'ambiguous', candidates: hourMatches };
    }
    if (num >= 1 && num <= horariosLibres.length) {
      return { status: 'matched', hora: horariosLibres[num - 1] };
    }
  }

  const candidates = extractHoraCandidates(trimmed);
  const matchedLibres = matchCandidatesAgainstLibres(candidates, horariosLibres);

  if (matchedLibres.length === 0) {
    const direct = horariosLibres.find(
      h => trimmed === h || trimmed.includes(h) || h.includes(trimmed.replace(/\./g, ':'))
    );
    if (direct) return { status: 'matched', hora: direct };
    return { status: 'none' };
  }

  if (matchedLibres.length === 1) return { status: 'matched', hora: matchedLibres[0] };
  return { status: 'ambiguous', candidates: matchedLibres };
}
