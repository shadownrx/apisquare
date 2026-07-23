import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  executeNamedTool,
  getActiveToolDefinitions,
  buildSystemPrompt,
} from '../lib/assistant';
import type { AssistantToolHandlers, AssistantTurnInput } from '../lib/assistant/types';
import { extractPersonName, isValidFlowInput } from '../lib/bot-intent';

const BUG_TEXT = 'Okey, como sabes que me llamo salvador?';

describe('paso nombre: pregunta vs nombre real', () => {
  it('no trata la pregunta como input válido de nombre', () => {
    assert.equal(isValidFlowInput(BUG_TEXT, 'nombre'), false);
    assert.equal(extractPersonName(BUG_TEXT), undefined);
  });

  it('acepta Salvador y Juan Pérez como nombre', () => {
    assert.equal(isValidFlowInput('Salvador', 'nombre'), true);
    assert.equal(extractPersonName('Salvador'), 'Salvador');
    assert.equal(isValidFlowInput('Juan Pérez', 'nombre'), true);
    assert.equal(extractPersonName('Juan Pérez'), 'Juan Pérez');
  });

  it('omite set_patient_name del tool set cuando está disabled', () => {
    const tools = getActiveToolDefinitions(['set_patient_name']);
    assert.ok(!tools.some(t => t.function.name === 'set_patient_name'));
    assert.ok(tools.some(t => t.function.name === 'get_clinic_info'));
  });

  it('executeNamedTool no ejecuta set_patient_name si está disabled', async () => {
    let called = false;
    const handlers = {
      setPatientName: async () => {
        called = true;
        return {
          data: { accepted: true },
          sideEffect: {
            type: 'set_draft',
            draft: { paso: 'fecha', nombre: 'Salvador' },
          },
        };
      },
    } as unknown as AssistantToolHandlers;

    const result = await executeNamedTool(
      'set_patient_name',
      { nombre: 'Salvador' },
      handlers,
      ['set_patient_name']
    );

    assert.equal(called, false);
    assert.equal((result.data as { error?: string }).error?.includes('no disponible'), true);
    assert.equal(result.sideEffect, undefined);
  });

  it('prompt indica que set_patient_name no está disponible', () => {
    const prompt = buildSystemPrompt({
      userMessage: BUG_TEXT,
      chatId: 1,
      historyText: '',
      clinicContext: 'ctx',
      draft: { paso: 'nombre' },
      handlers: {} as AssistantTurnInput['handlers'],
      disabledTools: ['set_patient_name'],
      turnHint: 'NO guardes nombre',
    });
    assert.match(prompt, /NO disponible este turno/i);
    assert.match(prompt, /NO guardes nombre/);
  });
});
