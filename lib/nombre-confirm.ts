import { sanitizePersonName } from './bot-intent';
import type { ConversationState } from './types';

/** Nombre ya confirmado en este draft (botón o texto válido), no solo KV. */
export function isNombreConfirmadoEnDraft(
  estado: Pick<ConversationState, 'nombre' | 'nombreConfirmado'> | null | undefined
): boolean {
  return Boolean(estado?.nombreConfirmado && sanitizePersonName(estado.nombre));
}

/**
 * Tras elegir hora: si el nombre no está confirmado en el draft, hay que
 * mostrar buildNombreStep (aunque KV tenga nombre).
 */
export function shouldPromptNombreConfirm(
  estado: Pick<ConversationState, 'nombre' | 'nombreConfirmado'> | null | undefined
): boolean {
  return !isNombreConfirmadoEnDraft(estado);
}
