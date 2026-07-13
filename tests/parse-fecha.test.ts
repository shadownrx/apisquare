import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dayOfWeekFromFechaStr,
  getToday,
  getTodayStr,
  parseFecha,
  toDateStr,
} from '../lib/parse-fecha';

describe('parseFecha / getToday', () => {
  it('getToday usa el calendario de Argentina (no UTC crudo)', () => {
    const today = getToday();
    const todayStr = getTodayStr();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Argentina/Buenos_Aires',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const y = Number(parts.find(p => p.type === 'year')?.value);
    const m = Number(parts.find(p => p.type === 'month')?.value);
    const d = Number(parts.find(p => p.type === 'day')?.value);

    assert.equal(today.getFullYear(), y);
    assert.equal(today.getMonth(), m - 1);
    assert.equal(today.getDate(), d);
    assert.equal(todayStr, `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
  });

  it('"hoy" coincide con getToday()', () => {
    assert.equal(parseFecha('Hoy'), toDateStr(getToday()));
    assert.equal(parseFecha('hoy'), getTodayStr());
  });

  it('acepta fecha ISO y dd/mm', () => {
    assert.equal(parseFecha('2026-07-13'), '2026-07-13');
    assert.equal(parseFecha('13/07/2026'), '2026-07-13');
  });

  it('dayOfWeekFromFechaStr es estable (lunes = 1)', () => {
    // 2026-07-13 es lunes
    assert.equal(dayOfWeekFromFechaStr('2026-07-13'), 1);
    // 2026-07-12 es domingo
    assert.equal(dayOfWeekFromFechaStr('2026-07-12'), 0);
  });
});
