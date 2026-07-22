import { runGeminiAssistantTurn } from './gemini';
import { runGroqAssistantTurn } from './groq';
import type { AssistantTurnInput, AssistantTurnResult } from './types';

export type AssistantProvider = 'gemini' | 'groq';

export function getAssistantProvider(): AssistantProvider {
  const raw = (process.env.ASSISTANT_PROVIDER || 'gemini').trim().toLowerCase();
  return raw === 'groq' ? 'groq' : 'gemini';
}

/**
 * Entrypoint único del asistente.
 * Default: Gemini. Si falla o no hay key, intenta Groq. Si ambos fallan → viaLlm:false.
 */
export async function runAssistantTurn(
  input: AssistantTurnInput
): Promise<AssistantTurnResult> {
  const preferred = getAssistantProvider();

  if (preferred === 'gemini') {
    const gemini = await runGeminiAssistantTurn(input);
    if (gemini.viaLlm) return gemini;

    const groq = await runGroqAssistantTurn(input);
    if (groq.viaLlm) {
      console.warn('[assistant] Gemini falló; usando Groq como fallback');
      return groq;
    }
    return gemini;
  }

  const groq = await runGroqAssistantTurn(input);
  if (groq.viaLlm) return groq;

  const gemini = await runGeminiAssistantTurn(input);
  if (gemini.viaLlm) {
    console.warn('[assistant] Groq falló; usando Gemini como fallback');
    return gemini;
  }
  return groq;
}
