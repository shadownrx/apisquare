export interface Reservation {
  id: string;
  profesional: string;
  servicio: string;
  nombre: string;
  fecha: string;
  hora: string;
  chatId: number;
  calendarEventId?: string;
  reminder24hSent?: boolean;
  reminder1hSent?: boolean;
}

export interface ConversationState {
  paso?: string | null;
  profesional?: string;
  servicio?: string;
  nombre?: string;
  fecha?: string;
  hora?: string;
  rescheduleId?: string;
  updatedAt?: number;
}

/** Campos a borrar explícitamente al guardar estado (undefined no borra). */
export type StatePatch = ConversationState & {
  clear?: Array<keyof ConversationState>;
};

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  ts: number;
}
