import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { executeNamedTool, mergeToolUi } from '../lib/assistant/shared';
import type { AssistantToolHandlers, ToolExecutionResult } from '../lib/assistant/types';

describe('mergeToolUi', () => {
  it('hold_slot exitoso no deja que get_availability pise el teclado', () => {
    const hold: ToolExecutionResult = {
      data: { held: true, readyToConfirm: true },
      keyboard: [[{ text: '✅ Confirmar', callback_data: 'confirmar_reserva' }]],
      sideEffect: {
        type: 'set_draft',
        draft: { paso: 'confirmar', hora: '11:00' },
      },
    };
    const afterHold = mergeToolUi('hold_slot', hold, {
      keyboard: null,
      sideEffect: null,
      lockedByHold: false,
    });
    assert.equal(afterHold.lockedByHold, true);
    assert.equal(afterHold.keyboard?.[0]?.[0]?.callback_data, 'confirmar_reserva');

    const avail: ToolExecutionResult = {
      data: { slots: ['11:00', '11:25'] },
      keyboard: [
        [
          { text: '11:00', callback_data: 'hora:11:00' },
          { text: '11:25', callback_data: 'hora:11:25' },
        ],
      ],
    };
    const afterAvail = mergeToolUi('get_availability', avail, afterHold);
    assert.equal(afterAvail.keyboard?.[0]?.[0]?.callback_data, 'confirmar_reserva');
    assert.equal(afterAvail.sideEffect?.type, 'set_draft');
  });

  it('set_patient_name readyToConfirm tampoco se pisa con get_availability', () => {
    const named: ToolExecutionResult = {
      data: { accepted: true, readyToConfirm: true },
      keyboard: [[{ text: '✅ Confirmar', callback_data: 'confirmar_reserva' }]],
      sideEffect: {
        type: 'set_draft',
        draft: { paso: 'confirmar', nombre: 'Salvador' },
      },
    };
    const afterName = mergeToolUi('set_patient_name', named, {
      keyboard: null,
      sideEffect: null,
      lockedByHold: false,
    });
    assert.equal(afterName.lockedByHold, true);

    const avail: ToolExecutionResult = {
      data: { slots: ['11:00'] },
      keyboard: [[{ text: '11:00', callback_data: 'hora:11:00' }]],
    };
    const afterAvail = mergeToolUi('get_availability', avail, afterName);
    assert.equal(afterAvail.keyboard?.[0]?.[0]?.callback_data, 'confirmar_reserva');
  });
});

function stubHandlers(
  overrides: Partial<AssistantToolHandlers> = {}
): AssistantToolHandlers {
  return {
    getClinicInfo: async () => ({ data: {} }),
    getMyAppointments: async () => ({ data: {} }),
    getAvailability: async () => ({ data: {} }),
    holdSlot: async () => ({ data: {} }),
    setPatientName: async () => ({ data: {} }),
    confirmBooking: async () => ({ data: {} }),
    ...overrides,
  };
}

describe('executeNamedTool hold_slot', () => {
  it('normaliza hora y delega al handler', async () => {
    let received: unknown = null;
    const handlers = stubHandlers({
      holdSlot: async args => {
        received = args;
        return { data: { held: true }, keyboard: [] };
      },
    });

    await executeNamedTool(
      'hold_slot',
      { profesional: 'Francisco', servicio: 'Quiropraxia', fecha: '2026-07-21', hora: '11' },
      handlers
    );
    assert.deepEqual(received, {
      profesional: 'Francisco',
      servicio: 'Quiropraxia',
      fecha: '2026-07-21',
      hora: '11:00',
      nombre: undefined,
    });
  });
});

describe('executeNamedTool set_patient_name', () => {
  it('delega el nombre al handler', async () => {
    let received: unknown = null;
    const handlers = stubHandlers({
      setPatientName: async args => {
        received = args;
        return { data: { accepted: true, nombre: 'Salvador' } };
      },
    });

    await executeNamedTool('set_patient_name', { nombre: 'Salvador' }, handlers);
    assert.deepEqual(received, { nombre: 'Salvador' });
  });

  it('rechaza nombre vacío', async () => {
    const result = await executeNamedTool('set_patient_name', { nombre: '  ' }, stubHandlers());
    assert.equal(
      (result.data as { error?: string }).error,
      'set_patient_name requiere nombre (string)'
    );
  });
});

describe('executeNamedTool confirm_booking', () => {
  it('delega confirm al handler', async () => {
    let received: unknown = null;
    const handlers = stubHandlers({
      confirmBooking: async args => {
        received = args;
        return { data: { booked: true } };
      },
    });
    await executeNamedTool('confirm_booking', { confirm: true }, handlers);
    assert.deepEqual(received, { confirm: true });
  });
});
