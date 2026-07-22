import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildAppointmentsToolResult } from '../lib/assistant/appointments-ui';
import type { Reservation } from '../lib/types';

function r(partial: Partial<Reservation> & Pick<Reservation, 'id' | 'fecha' | 'hora'>): Reservation {
  return {
    id: partial.id,
    profesional: partial.profesional || 'Francisco Chibilisco',
    servicio: partial.servicio || 'Masaje Relajante',
    nombre: partial.nombre || 'Ana',
    fecha: partial.fecha,
    hora: partial.hora,
    chatId: 1,
  };
}

describe('buildAppointmentsToolResult', () => {
  it('status con un turno trae teclado cambiar/cancelar', () => {
    const result = buildAppointmentsToolResult(
      [r({ id: 'abc', fecha: '2026-07-18', hora: '09:00' })],
      0,
      'status'
    );
    assert.equal((result.data as { count: number }).count, 1);
    assert.ok(result.keyboard);
    assert.ok(result.keyboard!.some(row => row.some(b => b.callback_data.startsWith('reprogramar:'))));
    assert.equal(result.sideEffect, undefined);
    const data = result.data as {
      nextAppointment?: { timeUntilLabel?: string; minutesUntil?: number };
    };
    assert.ok(data.nextAppointment?.timeUntilLabel);
    assert.equal(typeof data.nextAppointment?.minutesUntil, 'number');
  });

  it('change con un turno dispara start_reschedule', () => {
    const reserva = r({ id: 'xyz', fecha: '2026-07-18', hora: '09:00' });
    const result = buildAppointmentsToolResult([reserva], 0, 'change');
    assert.equal(result.sideEffect?.type, 'start_reschedule');
    if (result.sideEffect?.type === 'start_reschedule') {
      assert.equal(result.sideEffect.reserva.id, 'xyz');
    }
  });

  it('cancel con un turno dispara confirm_cancel', () => {
    const result = buildAppointmentsToolResult(
      [r({ id: 'c1', fecha: '2026-07-18', hora: '09:00' })],
      0,
      'cancel'
    );
    assert.equal(result.sideEffect?.type, 'confirm_cancel');
  });

  it('change con varios turnos pide elegir con botones', () => {
    const result = buildAppointmentsToolResult(
      [
        r({ id: '1', fecha: '2026-07-18', hora: '09:00' }),
        r({ id: '2', fecha: '2026-07-20', hora: '11:00' }),
      ],
      0,
      'change'
    );
    assert.equal(result.sideEffect, undefined);
    assert.ok(result.keyboard);
    assert.equal((result.data as { count: number }).count, 2);
  });
});
