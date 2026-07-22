import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  dayOfWeekFromFechaStr,
  getNowMinutesInArgentina,
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

  it('getNowMinutesInArgentina está ~3h detrás de UTC', () => {
    const art = getNowMinutesInArgentina();
    const now = new Date();
    const utc = now.getUTCHours() * 60 + now.getUTCMinutes();
    let diff = utc - art;
    if (diff < 0) diff += 24 * 60;
    if (diff > 12 * 60) diff = 24 * 60 - diff;
    assert.ok(Math.abs(diff - 180) <= 1, `diff=${diff} art=${art} utc=${utc}`);
  });

  it('a las 10:48 ART no marca como pasados los turnos de las 11:00', () => {
    const utcMs = Date.UTC(2026, 6, 15, 13, 48, 0);
    assert.equal(getTodayStr(utcMs), '2026-07-15');
    assert.equal(getNowMinutesInArgentina(utcMs), 10 * 60 + 48);
    assert.ok(11 * 60 > getNowMinutesInArgentina(utcMs));
  });

  it('entiende hoy en frases humanas', () => {
    const today = getTodayStr();
    assert.equal(parseFecha('hoy'), today);
    assert.equal(parseFecha('Tienes para hoy?'), today);
    assert.equal(parseFecha('hay lugar para hoy'), today);
    assert.equal(parseFecha('hoy mismo'), today);
  });

  it('entiende manana en frases, pero no "por la manana"', () => {
    assert.ok(parseFecha('mañana'));
    assert.ok(parseFecha('para mañana'));
    assert.ok(parseFecha('Y para mañana 19?'));
    assert.ok(parseFecha('Tienes turno para las 11 de mañana?'));
    assert.ok(parseFecha('las 11 de mañana'));
    assert.equal(parseFecha('por la mañana'), null);
    assert.equal(parseFecha('turno a la mañana'), null);
    assert.equal(parseFecha('a las 11 de la mañana'), null);
  });

  it('"hoy" coincide con getToday()', () => {
    assert.equal(parseFecha('Hoy'), toDateStr(getToday()));
    assert.equal(parseFecha('hoy'), getTodayStr());
  });

  it('acepta fecha ISO y dd/mm', () => {
    assert.equal(parseFecha('2026-07-13'), '2026-07-13');
    assert.equal(parseFecha('13/07/2026'), '2026-07-13');
  });

  it('entiende weekday + día (corrige número que no calza)', () => {
    const lunes = parseFecha('lunes');
    assert.ok(lunes);
    assert.equal(dayOfWeekFromFechaStr(lunes!), 1);
    // "lunes 21" cuando 21 no es lunes → igual el próximo lunes
    assert.equal(parseFecha('Bueno para el lunes 21?'), lunes);
  });

  it('entiende día + mes en frases humanas', () => {
    const a = parseFecha('20 de julio');
    const b = parseFecha('Tenes disponible para el 20 de julio?');
    const c = parseFecha('Hola, necesito un turno para el lunes 20 de julio');
    assert.ok(a && a.endsWith('-07-20'));
    assert.equal(b, a);
    assert.equal(c, a);
  });

  it('dayOfWeekFromFechaStr es estable (lunes = 1)', () => {
    assert.equal(dayOfWeekFromFechaStr('2026-07-13'), 1);
  });
});
