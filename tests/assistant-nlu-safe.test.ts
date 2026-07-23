import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import {
  consumeGeminiRateLimit,
  resetGeminiRateLimitForTests,
  GEMINI_RATE_LIMIT_MAX,
} from '../lib/assistant/rate-limit';
import { buildSystemPrompt } from '../lib/assistant/shared';
import { ASSISTANT_TOOL_DEFINITIONS } from '../lib/assistant/tool-defs';
import type { AssistantTurnInput } from '../lib/assistant/types';
import { parseLocalIntent } from '../lib/bot-intent';

describe('gemini rate limit', () => {
  beforeEach(() => {
    resetGeminiRateLimitForTests(42);
  });

  it('permite hasta MAX mensajes y luego bloquea', async () => {
    for (let i = 0; i < GEMINI_RATE_LIMIT_MAX; i++) {
      const r = await consumeGeminiRateLimit(42);
      assert.equal(r.allowed, true, `slot ${i + 1}`);
    }
    const blocked = await consumeGeminiRateLimit(42);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.remaining, 0);
  });
});

describe('prompt NLU seguro', () => {
  it('deja prosa al modelo y pide tools para hechos', () => {
    const prompt = buildSystemPrompt({
      userMessage: 'test',
      chatId: 1,
      historyText: '',
      clinicContext: 'ctx',
      draft: {},
      handlers: {} as AssistantTurnInput['handlers'],
    });
    assert.match(prompt, /Escribís vos cada respuesta/i);
    assert.match(prompt, /Nunca inventes cupos/i);
    assert.match(prompt, /profesionales/);
    assert.doesNotMatch(prompt, /FORMATO \(Telegram Markdown/i);
  });
});

describe('get_clinic_info topics', () => {
  it('incluye topic profesionales', () => {
    const clinic = ASSISTANT_TOOL_DEFINITIONS.find(t => t.function.name === 'get_clinic_info');
    assert.ok(clinic);
    const topic = clinic!.function.parameters.properties.topic as { enum?: string[] };
    assert.ok(topic.enum?.includes('profesionales'));
  });
});

describe('fallback reglas profesionales', () => {
  it('detecta qué médicos atienden', () => {
    const intent = parseLocalIntent('Que medicos atienden?');
    assert.equal(intent?.action, 'profesionales');
  });
});
