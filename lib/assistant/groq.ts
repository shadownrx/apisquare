import axios from 'axios';
import { getActiveToolDefinitions } from './tool-defs';
import {
  MAX_TOOL_ROUNDS,
  buildSystemPrompt,
  buildUserPrompt,
  executeNamedTool,
  mergeToolUi,
} from './shared';
import type { AssistantSideEffect, AssistantTurnInput, AssistantTurnResult } from './types';

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
};

/**
 * Asistente con Groq function calling.
 * Si no hay API key o falla, retorna viaLlm:false para que el webhook haga fallback.
 */
export async function runGroqAssistantTurn(
  input: AssistantTurnInput
): Promise<AssistantTurnResult> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    return { text: '', keyboard: null, sideEffect: null, usedTools: [], viaLlm: false };
  }

  const model = process.env.GROQ_MODEL?.trim() || 'llama-3.3-70b-versatile';
  const messages: ChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(input) },
    { role: 'user', content: buildUserPrompt(input) },
  ];

  let keyboard: AssistantTurnResult['keyboard'] = null;
  let sideEffect: AssistantSideEffect | null = null;
  let lockedByHold = false;
  const usedTools: string[] = [];

  try {
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const { data } = await axios.post(
        'https://api.groq.com/openai/v1/chat/completions',
        {
          model,
          messages,
          tools: getActiveToolDefinitions(input.disabledTools),
          tool_choice: 'auto',
          temperature: 0.4,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 20000,
        }
      );

      const choice = data.choices?.[0]?.message;
      if (!choice) break;

      const toolCalls = choice.tool_calls as ChatMessage['tool_calls'];
      if (toolCalls && toolCalls.length > 0) {
        messages.push({
          role: 'assistant',
          content: choice.content || null,
          tool_calls: toolCalls,
        });

        for (const call of toolCalls) {
          usedTools.push(call.function.name);
          const result = await executeNamedTool(
            call.function.name,
            call.function.arguments || '{}',
            input.handlers,
            input.disabledTools
          );
          const merged = mergeToolUi(call.function.name, result, {
            keyboard,
            sideEffect,
            lockedByHold,
          });
          keyboard = merged.keyboard;
          sideEffect = merged.sideEffect;
          lockedByHold = merged.lockedByHold;
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: JSON.stringify(result.data),
          });
        }
        continue;
      }

      return {
        text: (choice.content || '').trim(),
        keyboard,
        sideEffect,
        usedTools,
        viaLlm: true,
      };
    }

    const { data } = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model,
        messages: [
          ...messages,
          {
            role: 'user',
            content: 'Respondé al paciente con lo que ya tenés. Sin llamar más tools.',
          },
        ],
        temperature: 0.3,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );

    return {
      text: (data.choices?.[0]?.message?.content || '').trim(),
      keyboard,
      sideEffect,
      usedTools,
      viaLlm: true,
    };
  } catch (error) {
    console.error('[assistant/groq] error:', error);
    return { text: '', keyboard: null, sideEffect: null, usedTools, viaLlm: false };
  }
}
