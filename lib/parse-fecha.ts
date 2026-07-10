export function toDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function getToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
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
