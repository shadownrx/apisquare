import { getTodayStr } from '../parse-fecha';
import type {
  AppointmentsAction,
  AssistantKeyboard,
  AssistantSideEffect,
  AssistantToolHandlers,
  AssistantTurnInput,
  ClinicInfoTopic,
  ToolExecutionResult,
} from './types';

export const MAX_TOOL_ROUNDS = 5;

/** hold_slot / set_patient_name exitosos ganan sobre get_availability (evitar re-listar horas). */
export function mergeToolUi(
  toolName: string,
  result: ToolExecutionResult,
  current: {
    keyboard: AssistantKeyboard | null;
    sideEffect: AssistantSideEffect | null;
    lockedByHold: boolean;
  }
): {
  keyboard: AssistantKeyboard | null;
  sideEffect: AssistantSideEffect | null;
  lockedByHold: boolean;
} {
  const data =
    typeof result.data === 'object' && result.data !== null
      ? (result.data as { held?: boolean; readyToConfirm?: boolean; accepted?: boolean; booked?: boolean })
      : null;
  const lockedNow =
    (toolName === 'hold_slot' && data?.held === true) ||
    (toolName === 'set_patient_name' && (data?.readyToConfirm === true || data?.accepted === true)) ||
    (toolName === 'confirm_booking' && data?.booked === true);

  if (current.lockedByHold && !lockedNow) {
    return current;
  }
  return {
    keyboard: result.keyboard ?? current.keyboard,
    sideEffect: result.sideEffect ?? current.sideEffect,
    lockedByHold: current.lockedByHold || lockedNow,
  };
}

export function buildSystemPrompt(input: AssistantTurnInput): string {
  const draft = input.draft?.paso
    ? `Reserva en curso (interno): profesional=${input.draft.profesional || '-'}, servicio=${input.draft.servicio || '-'}, fecha=${input.draft.fecha || '-'}, hora=${input.draft.hora || '-'}, nombre=${input.draft.nombre || '-'}.`
    : 'No hay reserva en curso.';

  return `Sos el asistente de la clínica (quiropraxia y masajes, Tucumán) por Telegram.
Escribís vos cada respuesta al paciente: natural, corta, rioplatense. Telegram Markdown (*negrita*) cuando ayude.
Los botones son atajos del sistema; no hace falta repetir en el texto lo que ya está en el teclado.

Usá tools para hechos. Nunca inventes cupos, precios ni turnos del paciente.
- get_availability → cupos para un turno NUEVO (fecha YYYY-MM-DD; ventana → horaDesde/horaHasta; "a las 10" → horaPreferida)
- hold_slot → eligió una hora concreta (no autotrabes desde get_availability)
- set_patient_name → dijo su nombre y falta en el draft / needNombre
- confirm_booking → confirma (true) o cancela (false) el turno trabado; no digas "reservado" sin llamarla
- get_my_appointments → SU turno (cuánto falta, cambiar, cancelar); no pidas un día nuevo
- get_clinic_info → info general (NO cupos)

Si la tool trae needServiceChoice / needNombre, pedí eso. recommendation = sugerencia, no elección del paciente.
"mañana" = día siguiente; "por la mañana" = franja.
Respondé siempre a lo que preguntó, aunque haya una reserva a medias.

Hoy en Argentina: ${getTodayStr()}.

${input.clinicContext}

${draft}
${input.profileSummary ? `Perfil: ${input.profileSummary}` : ''}
`;
}

function asHora(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.trim();
  if (/^\d{1,2}:\d{2}$/.test(t)) {
    const [h, m] = t.split(':').map(Number);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
  if (/^\d{1,2}$/.test(t)) {
    return `${t.padStart(2, '0')}:00`;
  }
  return undefined;
}

export async function executeNamedTool(
  name: string,
  rawArgs: string | Record<string, unknown>,
  handlers: AssistantToolHandlers
): Promise<ToolExecutionResult> {
  let args: Record<string, unknown> = {};
  if (typeof rawArgs === 'string') {
    try {
      args = rawArgs ? JSON.parse(rawArgs) : {};
    } catch {
      args = {};
    }
  } else if (rawArgs && typeof rawArgs === 'object') {
    args = rawArgs;
  }

  switch (name) {
    case 'get_clinic_info': {
      const topic = (args.topic as ClinicInfoTopic) || 'general';
      return handlers.getClinicInfo(topic);
    }
    case 'get_my_appointments': {
      const action = (args.action as AppointmentsAction) || 'status';
      return handlers.getMyAppointments(action);
    }
    case 'get_availability': {
      return handlers.getAvailability({
        profesional: typeof args.profesional === 'string' ? args.profesional : undefined,
        servicio: typeof args.servicio === 'string' ? args.servicio : undefined,
        fecha: typeof args.fecha === 'string' ? args.fecha : undefined,
        franja:
          args.franja === 'manana' || args.franja === 'tarde' ? args.franja : undefined,
        horaDesde: asHora(args.horaDesde),
        horaHasta: asHora(args.horaHasta),
        horaPreferida: asHora(args.horaPreferida),
      });
    }
    case 'hold_slot': {
      const hora = asHora(args.hora);
      if (
        typeof args.profesional !== 'string' ||
        typeof args.servicio !== 'string' ||
        typeof args.fecha !== 'string' ||
        !hora
      ) {
        return {
          data: {
            error: 'hold_slot requiere profesional, servicio, fecha (YYYY-MM-DD) y hora (HH:MM)',
          },
        };
      }
      return handlers.holdSlot({
        profesional: args.profesional,
        servicio: args.servicio,
        fecha: args.fecha,
        hora,
        nombre: typeof args.nombre === 'string' ? args.nombre : undefined,
      });
    }
    case 'set_patient_name': {
      if (typeof args.nombre !== 'string' || !args.nombre.trim()) {
        return { data: { error: 'set_patient_name requiere nombre (string)' } };
      }
      return handlers.setPatientName({ nombre: args.nombre });
    }
    case 'confirm_booking': {
      const confirm = args.confirm === true || args.confirm === 'true';
      return handlers.confirmBooking({ confirm });
    }
    default:
      return { data: { error: `Tool desconocida: ${name}` } };
  }
}

export function buildUserPrompt(input: AssistantTurnInput): string {
  return input.userMessage;
}
