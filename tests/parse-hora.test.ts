import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  extractHoraCandidates,
  looksLikeHoraInput,
  parseHoraSelection,
} from '../lib/parse-hora';

const LIBRES = ['15:30', '16:30', '17:30', '18:30'];

describe('extractHoraCandidates', () => {
  it('lee formatos comunes', () => {
    assert.deepEqual(extractHoraCandidates('15:30'), ['15:30']);
    assert.deepEqual(extractHoraCandidates('15.30'), ['15:30']);
    assert.deepEqual(extractHoraCandidates('1530'), ['15:30']);
  });

  it('lee varias horas en una frase', () => {
    assert.deepEqual(extractHoraCandidates('15:30 un 16:30'), ['15:30', '16:30']);
    assert.deepEqual(extractHoraCandidates('15:30 o 16:30'), ['15:30', '16:30']);
    assert.deepEqual(extractHoraCandidates('a las 15 o a las 17'), ['15:00', '17:00']);
  });
});

describe('looksLikeHoraInput', () => {
  it('detecta horarios y preferencias', () => {
    assert.equal(looksLikeHoraInput('15:30'), true);
    assert.equal(looksLikeHoraInput('15:30 un 16:30'), true);
    assert.equal(looksLikeHoraInput('por la tarde'), true);
    assert.equal(looksLikeHoraInput('hola'), false);
  });
});

describe('parseHoraSelection', () => {
  it('matchea 15:30 exacto', () => {
    assert.deepEqual(parseHoraSelection('15:30', LIBRES), { status: 'matched', hora: '15:30' });
  });

  it('matchea variantes 15.30 / 1530', () => {
    assert.deepEqual(parseHoraSelection('15.30', LIBRES), { status: 'matched', hora: '15:30' });
    assert.deepEqual(parseHoraSelection('1530', LIBRES), { status: 'matched', hora: '15:30' });
  });

  it('si tiran dos horarios, pide desambiguar', () => {
    assert.deepEqual(parseHoraSelection('15:30 un 16:30', LIBRES), {
      status: 'ambiguous',
      candidates: ['15:30', '16:30'],
    });
    assert.deepEqual(parseHoraSelection('15:30 o 16:30', LIBRES), {
      status: 'ambiguous',
      candidates: ['15:30', '16:30'],
    });
  });

  it('a las 15 resuelve al único slot de esa hora', () => {
    assert.deepEqual(parseHoraSelection('a las 15', LIBRES), { status: 'matched', hora: '15:30' });
    assert.deepEqual(parseHoraSelection('15', LIBRES), { status: 'matched', hora: '15:30' });
  });

  it('indice numerico cuando no choca con una hora', () => {
    assert.deepEqual(parseHoraSelection('2', LIBRES), { status: 'matched', hora: '16:30' });
  });

  it('el primero / cualquiera', () => {
    assert.deepEqual(parseHoraSelection('el primero', LIBRES), { status: 'matched', hora: '15:30' });
    assert.deepEqual(parseHoraSelection('cualquiera', LIBRES), { status: 'matched', hora: '15:30' });
  });

  it('horario no disponible → none', () => {
    assert.deepEqual(parseHoraSelection('10:00', LIBRES), { status: 'none' });
  });
});
