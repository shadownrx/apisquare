import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  isNombreConfirmadoEnDraft,
  shouldPromptNombreConfirm,
} from '../lib/nombre-confirm';

describe('nombreConfirmado en draft', () => {
  it('KV solo (nombre sin flag) exige preguntar antes de confirmar turno', () => {
    const estado = { paso: 'hora' as const, nombre: 'Salvador' };
    assert.equal(isNombreConfirmadoEnDraft(estado), false);
    assert.equal(shouldPromptNombreConfirm(estado), true);
  });

  it('tras usar_nombre / texto válido no vuelve a preguntar', () => {
    const estado = {
      paso: 'hora' as const,
      nombre: 'Salvador',
      nombreConfirmado: true,
    };
    assert.equal(isNombreConfirmadoEnDraft(estado), true);
    assert.equal(shouldPromptNombreConfirm(estado), false);
  });

  it('flag true sin nombre usable no cuenta como confirmado', () => {
    assert.equal(isNombreConfirmadoEnDraft({ nombreConfirmado: true }), false);
    assert.equal(shouldPromptNombreConfirm({ nombreConfirmado: true, nombre: 'ok' }), true);
  });

  it('simula el caso: eligió hora con Salvador en KV → debe prompt', () => {
    // Como proceedAfterSlotChosen / hold_slot: sin nombreConfirmado → buildNombreStep
    const draftTrasElegirHora = {
      paso: 'hora',
      profesional: 'Francisco Chibilisco',
      servicio: 'Masaje Relajante',
      fecha: '2026-07-24',
      hora: '11:00',
      // nombre aún no está; KV tiene Salvador pero el draft no confirma
    };
    assert.equal(shouldPromptNombreConfirm(draftTrasElegirHora), true);

    // buildNombreStep pondría nombre=Salvador sin nombreConfirmado
    const trasPantallaConfirm = { ...draftTrasElegirHora, paso: 'nombre', nombre: 'Salvador' };
    assert.equal(shouldPromptNombreConfirm(trasPantallaConfirm), true);

    // Usuario tocó usar_nombre
    const trasUsarNombre = { ...trasPantallaConfirm, nombreConfirmado: true, paso: 'confirmar' };
    assert.equal(shouldPromptNombreConfirm(trasUsarNombre), false);

    // Cambió de hora: sigue confirmado → no re-preguntar
    const trasCambiarHora = { ...trasUsarNombre, paso: 'hora', hora: '12:00' };
    assert.equal(shouldPromptNombreConfirm(trasCambiarHora), false);
  });
});
