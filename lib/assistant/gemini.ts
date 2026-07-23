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
  clearGeminiHistory,
  getGeminiHistory,
  replaceGeminiHistoryFromChat,
} from './gemini-history';
import { MAX_TOOL_ROUNDS, buildSystemPrompt, executeNamedTool, mergeToolUi } from './shared';
import type { AssistantKeyboard, AssistantSideEffect, AssistantTurnInput, AssistantTurnResult } from './types';

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

type GeminiUiState = {
  keyboard: AssistantKeyboard | null;
  sideEffect: AssistantSideEffect | null;
  lockedByHold: boolean;
  usedTools: string[];
};

async function runGeminiChatTurn(
  input: AssistantTurnInput,
  historyForChat: Content[],
  userText: string,
  systemInstruction: string,
  modelName: string,
  apiKey: string
): Promise<AssistantTurnResult> {
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

  const ui: GeminiUiState = {
    keyboard: null,
    sideEffect: null,
    lockedByHold: false,
    usedTools: [],
  };

  let result = await chat.sendMessage(userText);

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const functionCalls = result.response.functionCalls();
    if (!functionCalls?.length) break;

    const responseParts: Part[] = [];
    for (const call of functionCalls) {
      ui.usedTools.push(call.name);
      const args =
        call.args && typeof call.args === 'object'
          ? (call.args as Record<string, unknown>)
          : {};
      const toolResult = await executeNamedTool(call.name, args, input.handlers);
      const merged = mergeToolUi(call.name, toolResult, {
        keyboard: ui.keyboard ?? null,
        sideEffect: ui.sideEffect,
        lockedByHold: ui.lockedByHold,
      });
      ui.keyboard = merged.keyboard;
      ui.sideEffect = merged.sideEffect;
      ui.lockedByHold = merged.lockedByHold;
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

  // Si no escribió prosa, forzar una respuesta al paciente (con o sin tools)
  if (!text) {
    try {
      result = await chat.sendMessage(
        'Respondé ahora al paciente en español rioplatense con lo que ya sabés (contexto y tools). Sin llamar más tools. No uses la palabra undefined.'
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

  const updated = await chat.getHistory();
  await replaceGeminiHistoryFromChat(String(input.chatId), updated);

  return {
    text,
    keyboard: ui.keyboard,
    sideEffect: ui.sideEffect,
    usedTools: ui.usedTools,
    viaLlm: true,
  };
}

/**
 * Agente Gemini con SDK oficial (@google/generative-ai):
 * - systemInstruction separado
 * - startChat() + historial por sessionId (chatId)
 * - si el historial está corrupto → limpia y reintenta 1 vez
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

  const attempt = async (): Promise<AssistantTurnResult> => {
    await appendGeminiUserTurn(sessionId, userText);
    // startChat no debe incluir el user actual (sendMessage lo agrega)
    const full = await getGeminiHistory(sessionId);
    const historyForChat = full.slice(0, -1);
    return runGeminiChatTurn(
      input,
      historyForChat,
      userText,
      systemInstruction,
      modelName,
      apiKey
    );
  };

  try {
    return await attempt();
  } catch (error: unknown) {
    console.error('[assistant/gemini] SDK error (reintentando sin historial):', error);
    try {
      await clearGeminiHistory(sessionId);
      return await attempt();
    } catch (retryError: unknown) {
      console.error('[assistant/gemini] SDK retry falló:', retryError);
      try {
        const hist = await getGeminiHistory(sessionId);
        if (hist.length && hist[hist.length - 1]?.role === 'user') {
          await replaceGeminiHistoryFromChat(sessionId, hist.slice(0, -1));
        }
      } catch {
        /* ignore */
      }
      return { text: '', keyboard: null, sideEffect: null, usedTools: [], viaLlm: false };
    }
  }
}
