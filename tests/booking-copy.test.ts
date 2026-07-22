import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildAvailabilityPatientMessage,
  buildTurnoStatusMessage,
  formatFechaRelativaAR,
} from '../lib/booking-copy';
import type { Reservation } from '../lib/types';

function reserva(partial: Partial<Reservation> & Pick<Reservation, 'fecha' | 'hora'>): Reservation {
  return {
    id: partial.id || 'abc123xyz',
    profesional: partial.profesional || 'Francisco Chibilisco',
    servicio: partial.servicio || 'Sesión Premium',
    nombre: partial.nombre || 'Juan',
    fecha: partial.fecha,
    hora: partial.hora,
    chatId: partial.chatId || 1,
  };
}

describe('formatFechaRelativaAR', () => {
  // 2026-07-17 15:00 ART = 18:00 UTC
  const nowMs = Date.parse('2026-07-17T18:00:00.000Z');

  it('dice hoy / mañana', () => {
    assert.equal(formatFechaRelativaAR('2026-07-17', nowMs), 'hoy');
    assert.equal(formatFechaRelativaAR('2026-07-18', nowMs), 'mañana');
  });
});

describe('buildAvailabilityPatientMessage', () => {
  it('pide servicio corto sin listar nombres', () => {
    const msg = buildAvailabilityPatientMessage({
      fechaLabel: 'mañana',
      needServiceChoice: true,
      horaPedida: '11:00',
      requestedHoraAvailable: false,
    });
    assert.match(msg, /no hay exactamente a las \*11:00\*/);
    assert.match(msg, /Tocá el servicio/);
    assert.doesNotMatch(msg, /Quiropraxia|Premium|Masaje/);
  });

  it('sugiere un solo ejemplo de horario', () => {
    const msg = buildAvailabilityPatientMessage({
      fechaLabel: 'martes, 21 de julio de 2026',
      recommendation: {
        hora: '11:25',
        profesional: 'Francisco Chibilisco',
        servicio: 'Sesión Premium',
      },
    });
    assert.match(msg, /\*11:25\*/);
    assert.match(msg, /\*Francisco\*/);
    assert.match(msg, /Elegí un horario/);
  });
});

describe('buildTurnoStatusMessage', () => {
  const nowMs = Date.parse('2026-07-17T18:00:00.000Z');

  it('sin turnos ofrece reservar', () => {
    const msg = buildTurnoStatusMessage([]);
    assert.match(msg, /Todavía no tenés reservas/);
  });

  it('un turno en lenguaje natural con CTA', () => {
    const msg = buildTurnoStatusMessage(
      [reserva({ fecha: '2026-07-18', hora: '11:00' })],
      { nowMs }
    );
    assert.match(msg, /Tenés turno \*mañana\*/);
    assert.match(msg, /11:00/);
    assert.match(msg, /Sesión Premium/);
    assert.match(msg, /Francisco/);
    assert.match(msg, /cambiás o lo cancelás/i);
  });

  it('varios turnos lista y pregunta', () => {
    const msg = buildTurnoStatusMessage(
      [
        reserva({ id: '1', fecha: '2026-07-18', hora: '11:00' }),
        reserva({
          id: '2',
          fecha: '2026-07-20',
          hora: '16:00',
          profesional: 'Javier Martoni',
          servicio: 'Quiropraxia',
        }),
      ],
      { nowMs }
    );
    assert.match(msg, /2 turnos/);
    assert.match(msg, /mañana/);
    assert.match(msg, /Javier/);
    assert.match(msg, /cambiar o cancelar/i);
  });
});
