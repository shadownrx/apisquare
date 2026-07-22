import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildSystemPrompt } from '../lib/assistant/shared';
import type { AssistantTurnInput } from '../lib/assistant/types';

describe('prompt chatbot empresa', () => {
  it('deja la prosa al modelo y exige tools para hechos', () => {
    const input = {
      userMessage: 'test',
      chatId: 1,
      historyText: '',
      clinicContext: 'ctx',
      draft: { paso: 'hora', fecha: '2026-07-20' },
      handlers: {} as AssistantTurnInput['handlers'],
    };
    const prompt = buildSystemPrompt(input);
    assert.match(prompt, /Escribís vos cada respuesta/i);
    assert.match(prompt, /needServiceChoice/i);
    assert.match(prompt, /Nunca inventes cupos/i);
    assert.match(prompt, /confirm_booking/);
    assert.match(prompt, /get_availability/);
    assert.doesNotMatch(prompt, /FORMATO \(Telegram Markdown/i);
    assert.doesNotMatch(prompt, /NUNCA un párrafo largo/i);
    assert.doesNotMatch(prompt, /Sin plantillas/i);
  });
});
