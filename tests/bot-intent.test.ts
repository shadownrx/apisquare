import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeHumanText,
  containsBookingIntent,
  looksLikeQuestion,
  parseInfoQuery,
  parseLocalIntent,
  matchesLoosely,
  isValidFlowInput,
  isValidPersonName,
} from '../lib/bot-intent';

describe('normalizeHumanText', () => {
  it('colapsa letras repetidas', () => {
    assert.equal(normalizeHumanText('Quierooo turnooo'), 'quiero turno');
    assert.equal(normalizeHumanText('buenaaaaas'), 'buenas');
  });

  it('quita acentos y signos', () => {
    assert.equal(normalizeHumanText('¿Cuánto cuesta???'), 'cuanto cuesta?');
    assert.equal(normalizeHumanText('MENÚ'), 'menu');
  });
});

describe('containsBookingIntent', () => {
  it('detecta mensajes informales de reserva', () => {
    assert.equal(containsBookingIntent('Quierooo turnooo'), true);
    assert.equal(containsBookingIntent('necesito un turnitooo'), true);
    assert.equal(containsBookingIntent('podes agendarme un turno?'), true);
    assert.equal(containsBookingIntent('dale quiero reservar'), true);
  });

  it('no confunde saludos simples con reserva', () => {
    assert.equal(containsBookingIntent('hola'), false);
    assert.equal(containsBookingIntent('buenas'), false);
  });
});

describe('parseInfoQuery', () => {
  it('detecta consultas de obra social', () => {
    assert.equal(parseInfoQuery('reciben obra social?'), 'obra_social');
    assert.equal(parseInfoQuery('aceptan OSDE'), 'obra_social');
  });

  it('detecta consultas de horarios', () => {
    assert.equal(parseInfoQuery('cuales son los horarios'), 'horarios');
    assert.equal(parseInfoQuery('cuando atienden'), 'horarios');
  });

  it('detecta consultas de precios', () => {
    assert.equal(parseInfoQuery('cuanto cuesta la sesion'), 'precios');
    assert.equal(parseInfoQuery('precio del masaje'), 'precios');
  });
});

describe('looksLikeQuestion', () => {
  it('identifica preguntas informativas', () => {
    assert.equal(looksLikeQuestion('queria saber si reciben prepaga'), true);
    assert.equal(looksLikeQuestion('cuanto sale'), true);
  });

  it('no marca pedidos de turno como pregunta informativa', () => {
    assert.equal(looksLikeQuestion('Quierooo turnooo'), false);
    assert.equal(looksLikeQuestion('quiero reservar un turno'), false);
  });
});

describe('parseLocalIntent', () => {
  it('interpreta lenguaje humano para reservar', () => {
    assert.deepEqual(parseLocalIntent('Quierooo turnooo'), { action: 'reservar' });
    assert.deepEqual(parseLocalIntent('necesito un turnitooo ya'), { action: 'reservar' });
    assert.deepEqual(parseLocalIntent('quiero sacar turno'), { action: 'reservar' });
  });

  it('responde consultas sin iniciar reserva', () => {
    assert.deepEqual(parseLocalIntent('Hola, queria saber si reciben obra social'), { action: 'consulta' });
    assert.deepEqual(parseLocalIntent('cuales son los horarios?'), { action: 'consulta' });
    assert.deepEqual(parseLocalIntent('cuanto cuesta'), { action: 'consulta' });
  });

  it('detecta menu y navegacion', () => {
    assert.deepEqual(parseLocalIntent('hola'), { action: 'menu' });
    assert.deepEqual(parseLocalIntent('cuales botones'), { action: 'menu' });
    assert.deepEqual(parseLocalIntent('/start'), { action: 'menu' });
  });

  it('diferencia mis reservas de pedir turno', () => {
    assert.deepEqual(parseLocalIntent('mis reservas'), { action: 'misreservas' });
    assert.deepEqual(parseLocalIntent('quiero ver mis reservas'), { action: 'misreservas' });
  });

  it('detecta otras acciones del menu', () => {
    assert.deepEqual(parseLocalIntent('mis reservas'), { action: 'misreservas' });
    assert.deepEqual(parseLocalIntent('ver servicios'), { action: 'servicios' });
    assert.deepEqual(parseLocalIntent('mostrame los profesionales'), { action: 'profesionales' });
  });

  it('devuelve null para mensajes no reconocidos', () => {
    assert.equal(parseLocalIntent('asdkj123'), null);
  });
});

describe('matchesLoosely', () => {
  it('matchea nombres con errores de tipeo', () => {
    assert.equal(matchesLoosely('francisco chibi', 'Francisco Chibilisco'), true);
    assert.equal(matchesLoosely('masaje relajantee', 'Masaje Relajante'), true);
  });
});

describe('isValidFlowInput', () => {
  it('acepta respuestas validas del flujo', () => {
    assert.equal(isValidFlowInput('Juan Perez', 'nombre'), true);
    assert.equal(isValidFlowInput('mañana', 'fecha'), true);
    assert.equal(isValidFlowInput('15:30', 'hora'), true);
    assert.equal(isValidFlowInput('Francisco Chibilisco', 'profesional'), true);
  });

  it('rechaza consultas durante el flujo', () => {
    assert.equal(isValidFlowInput('queria saber si reciben obra social', 'nombre'), false);
    assert.equal(isValidFlowInput('cuales son los horarios', 'fecha'), false);
    assert.equal(isValidFlowInput('Hola, queria saber si reciben obra social', 'nombre'), false);
  });

  it('rechaza nombres demasiado largos o frases completas', () => {
    assert.equal(isValidFlowInput('Me llamo Juan Carlos Rodriguez Martinez Lopez', 'nombre'), false);
  });

  it('rechaza confirmaciones y basura como nombre', () => {
    assert.equal(isValidPersonName('si'), false);
    assert.equal(isValidPersonName('dale'), false);
    assert.equal(isValidPersonName('ok'), false);
    assert.equal(isValidPersonName('Juan'), true);
    assert.equal(isValidPersonName('María López'), true);
  });
});
