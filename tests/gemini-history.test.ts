import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Content } from '@google/generative-ai';
import { trimGeminiHistory } from '../lib/assistant/gemini-history';

describe('trimGeminiHistory', () => {
  it('deja los últimos N turnos y empieza en user', () => {
    const history: Content[] = [];
    for (let i = 0; i < 10; i++) {
      history.push({ role: 'user', parts: [{ text: `u${i}` }] });
      history.push({ role: 'model', parts: [{ text: `m${i}` }] });
    }
    // historial “roto” empezando en model
    const broken: Content[] = [
      { role: 'model', parts: [{ text: 'orphan' }] },
      ...history,
    ];

    const trimmed = trimGeminiHistory(broken, 3);
    assert.equal(trimmed.length, 6);
    assert.equal(trimmed[0].role, 'user');
    assert.equal((trimmed[0].parts[0] as { text: string }).text, 'u7');
  });
});
