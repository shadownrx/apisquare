import type { ConversationState, Reservation } from '../types';

export type AssistantKeyboard = Array<Array<{ text: string; callback_data: string }>>;

export type ClinicInfoTopic =
  | 'horarios'
  | 'precios'
  | 'ubicacion'
  | 'pago'
  | 'obra_social'
  | 'que_traer'
  | 'estacionamiento'
  | 'duracion'
  | 'cancelacion'
  | 'general';

export type AppointmentsAction = 'status' | 'change' | 'cancel';

export type AssistantSideEffect =
  | { type: 'start_reschedule'; reserva: Reservation }
  | { type: 'confirm_cancel'; reserva: Reservation }
  | { type: 'handoff_reservar' }
  | { type: 'set_draft'; draft: ConversationState }
  | { type: 'clear_draft'; replyText?: string };

export type ToolExecutionResult = {
  /** JSON-serializable payload for the model */
  data: unknown;
  keyboard?: AssistantKeyboard;
  sideEffect?: AssistantSideEffect;
};

export type AssistantTurnResult = {
  text: string;
  keyboard?: AssistantKeyboard | null;
  sideEffect?: AssistantSideEffect | null;
  usedTools: string[];
  /** true if Groq ran; false if fallback */
  viaLlm: boolean;
};

export type AssistantToolHandlers = {
  getClinicInfo: (topic: ClinicInfoTopic) => Promise<ToolExecutionResult>;
  getMyAppointments: (action: AppointmentsAction) => Promise<ToolExecutionResult>;
  getAvailability: (args: {
    profesional?: string;
    servicio?: string;
    fecha?: string;
    franja?: 'manana' | 'tarde';
    /** Ventana del paciente, ej. "10:00" */
    horaDesde?: string;
    /** Ventana del paciente, ej. "13:00" */
    horaHasta?: string;
    /** Hora puntual pedida, ej. "10:00" */
    horaPreferida?: string;
  }) => Promise<ToolExecutionResult>;
  /** Cuando el paciente elige una hora concreta: traba el slot y pasa a confirmar (no listar horarios de nuevo). */
  holdSlot: (args: {
    profesional: string;
    servicio: string;
    fecha: string;
    hora: string;
    nombre?: string;
  }) => Promise<ToolExecutionResult>;
  /** Cuando el paciente dice su nombre tras needNombre / paso nombre. */
  setPatientName: (args: { nombre: string }) => Promise<ToolExecutionResult>;
  /** Confirma (o cancela) el turno trabado en draft. */
  confirmBooking: (args: { confirm: boolean }) => Promise<ToolExecutionResult>;
};

export type AssistantTurnInput = {
  userMessage: string;
  chatId: number;
  historyText: string;
  clinicContext: string;
  draft: ConversationState;
  profileSummary?: string;
  handlers: AssistantToolHandlers;
};
