import {
  FunctionCallingMode,
  GoogleGenerativeAI,
  SchemaType,
  type Content,
  type FunctionDeclaration,
  type Part,
  type Schema,
} from '@google/generative-ai';
import { ASSISTANT_TOOL_DEFINITIONS } from './tool-defs';
import {
  appendGeminiUserTurn,
  getGeminiHistory,
  replaceGeminiHistoryFromChat,
} from './gemini-history';
import { MAX_TOOL_ROUNDS, buildSystemPrompt, executeNamedTool, mergeToolUi } from './shared';
import type { AssistantSideEffect, AssistantTurnInput, AssistantTurnResult } from './types';

function toGeminiFunctionDeclarations(): FunctionDeclaration[] {
  return ASSISTANT_TOOL_DEFINITIONS.map(t => {
    const params = t.function.parameters as {
      type: string;
      properties: Record<string, unknown>;
      required?: string[];
    };

    const properties: { [k: string]: Schema } = {};
    for (const [key, raw] of Object.entries(params.properties || {})) {
      const prop = raw as { type?: string; description?: string; enum?: string[] };
      if (prop.enum?.length) {
        properties[key] = {
          type: SchemaType.STRING,
          description: prop.description,
          format: 'enum',
          enum: prop.enum,
        };
      } else {
        properties[key] = {
          type: SchemaType.STRING,
          description: prop.description,
        };
      }
    }

    return {
      name: t.function.name,
      description: t.function.description,
      parameters: {
        type: SchemaType.OBJECT,
        properties,
        required: params.required || [],
      },
    };
  });
}

function extractTextFromParts(parts: Part[] | undefined): string {
  if (!parts?.length) return '';
  return parts
    .map(p => ('text' in p && typeof p.text === 'string' ? p.text : ''))
    .join('')
    .trim();
}

/**
 * Agente Gemini con SDK oficial (@google/generative-ai):
 * - systemInstruction separado
 * - startChat() + historial por sessionId (chatId)
 * - user se persiste ANTES del call; model (vía getHistory) DESPUÉS
 */
export async function runGeminiAssistantTurn(
  input: AssistantTurnInput
): Promise<AssistantTurnResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    return { text: '', keyboard: null, sideEffect: null, usedTools: [], viaLlm: false };
  }

  const modelName = process.env.GEMINI_MODEL?.trim() || 'gemini-2.5-flash';
  const sessionId = String(input.chatId);
  const userText = input.userMessage.trim();
  if (!userText) {
    return { text: '', keyboard: null, sideEffect: null, usedTools: [], viaLlm: false };
  }

  const systemInstruction = buildSystemPrompt(input);

  // 1) Persistir turno user ANTES de llamar a la API
  await appendGeminiUserTurn(sessionId, userText);

  // 2) Historial previo (sin el último user: startChat + sendMessage lo reenvía)
  const fullHistory = await getGeminiHistory(sessionId);
  const historyForChat: Content[] = fullHistory.slice(0, -1);

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction,
    tools: [{ functionDeclarations: toGeminiFunctionDeclarations() }],
    toolConfig: {
      functionCallingConfig: { mode: FunctionCallingMode.AUTO },
    },
    generationConfig: {
      temperature: 0.75,
    },
  });

  const chat = model.startChat({
    history: historyForChat,
  });

  let keyboard: AssistantTurnResult['keyboard'] = null;
  let sideEffect: AssistantSideEffect | null = null;
  let lockedByHold = false;
  const usedTools: string[] = [];

  try {
    let result = await chat.sendMessage(userText);

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const functionCalls = result.response.functionCalls();
      if (!functionCalls?.length) break;

      const responseParts: Part[] = [];
      for (const call of functionCalls) {
        usedTools.push(call.name);
        const args =
          call.args && typeof call.args === 'object'
            ? (call.args as Record<string, unknown>)
            : {};
        const toolResult = await executeNamedTool(call.name, args, input.handlers);
        const merged = mergeToolUi(call.name, toolResult, {
          keyboard,
          sideEffect,
          lockedByHold,
        });
        keyboard = merged.keyboard;
        sideEffect = merged.sideEffect;
        lockedByHold = merged.lockedByHold;
        responseParts.push({
          functionResponse: {
            name: call.name,
            response:
              typeof toolResult.data === 'object' && toolResult.data !== null
                ? (toolResult.data as object)
                : { result: toolResult.data },
          },
        });
      }

      result = await chat.sendMessage(responseParts);
    }

    let text = '';
    try {
      text = result.response.text().trim();
    } catch {
      text = extractTextFromParts(result.response.candidates?.[0]?.content?.parts);
    }

    // Si usó tools pero no escribió prosa, forzar una respuesta al paciente
    if (!text && usedTools.length > 0) {
      try {
        result = await chat.sendMessage(
          'Respondé ahora al paciente en español rioplatense, con lo que ya tenés de las tools. Sin llamar más tools. No uses la palabra undefined.'
        );
        try {
          text = result.response.text().trim();
        } catch {
          text = extractTextFromParts(result.response.candidates?.[0]?.content?.parts);
        }
      } catch (followUpErr) {
        console.warn('[assistant/gemini] follow-up vacío falló:', followUpErr);
      }
    }

    // 3) Persistir historial completo que mantiene el chat (user + model [+ tools])
    const updated = await chat.getHistory();
    await replaceGeminiHistoryFromChat(sessionId, updated);

    return {
      text,
      keyboard,
      sideEffect,
      usedTools,
      viaLlm: true,
    };
  } catch (error: unknown) {
    console.error('[assistant/gemini] SDK error:', error);
    // Si falló el call, sacar el user huérfano del historial para no ensuciar el próximo turno
    try {
      const hist = await getGeminiHistory(sessionId);
      if (hist.length && hist[hist.length - 1]?.role === 'user') {
        await replaceGeminiHistoryFromChat(sessionId, hist.slice(0, -1));
      }
    } catch {
      /* ignore */
    }
    return { text: '', keyboard: null, sideEffect: null, usedTools, viaLlm: false };
  }
}
