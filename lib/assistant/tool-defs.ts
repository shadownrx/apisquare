/** OpenAI/Groq-compatible tool definitions for the clinic assistant. */
export const ASSISTANT_TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'get_clinic_info',
      description:
        'Datos fijos de la clínica: profesionales/médicos, horarios, precios, ubicación, pago, obra social, qué traer, estacionamiento, duración o cancelación. Usala para preguntas generales (NO para el turno personal del paciente).',
      parameters: {
        type: 'object',
        properties: {
          topic: {
            type: 'string',
            enum: [
              'horarios',
              'precios',
              'ubicacion',
              'pago',
              'obra_social',
              'que_traer',
              'estacionamiento',
              'duracion',
              'cancelacion',
              'profesionales',
              'general',
            ],
            description: 'Tema de la consulta. "qué médicos / quiénes atienden" → profesionales.',
          },
        },
        required: ['topic'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_my_appointments',
      description:
        'Turnos próximos DEL paciente que escribe. Usala si pregunta por su turno, a qué hora es, si ya reservó, o si quiere cambiar/cancelar su turno.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'change', 'cancel'],
            description:
              'status = consultar; change = quiere reprogramar; cancel = quiere cancelar. Default status.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_availability',
      description:
        'Cupos REALES reservables de un día (obligatoria para recomendar o reservar). NUNCA inventes horarios ni uses la agenda semanal de get_clinic_info como si fueran turnos libres. Pasá siempre la fecha del paciente en YYYY-MM-DD. Si dice "estoy de 10 a 13", usá horaDesde/horaHasta. Si pide "a las 10", usá horaPreferida.',
      parameters: {
        type: 'object',
        properties: {
          profesional: {
            type: 'string',
            description: 'Profesional si ya eligió. Si no, omitir: la tool barre a todos.',
          },
          servicio: {
            type: 'string',
            description: 'Servicio si ya eligió. Si no, omitir: la tool prueba los servicios.',
          },
          fecha: {
            type: 'string',
            description: 'Fecha YYYY-MM-DD del día pedido (martes 21 → esa fecha). Obligatoria si hay día.',
          },
          franja: {
            type: 'string',
            enum: ['manana', 'tarde'],
            description: 'Solo "por la mañana/tarde" como franja, no el día "mañana".',
          },
          horaDesde: {
            type: 'string',
            description: 'Inicio de ventana del paciente HH:MM (ej. 10:00)',
          },
          horaHasta: {
            type: 'string',
            description: 'Fin de ventana del paciente HH:MM (ej. 13:00)',
          },
          horaPreferida: {
            type: 'string',
            description: 'Hora puntual pedida HH:MM (ej. 10:00). Si no hay, la tool devuelve las más cercanas.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'hold_slot',
      description:
        'Cuando el paciente elige una hora ("a las 11", "11:00", "dale esa"). Verifica el cupo y deja el turno listo para confirmar. Usá profesional/servicio/fecha del contexto o de get_availability.',
      parameters: {
        type: 'object',
        properties: {
          profesional: { type: 'string', description: 'Nombre del profesional' },
          servicio: { type: 'string', description: 'Nombre del servicio' },
          fecha: { type: 'string', description: 'YYYY-MM-DD' },
          hora: { type: 'string', description: 'HH:MM elegida' },
          nombre: { type: 'string', description: 'Nombre del paciente si ya lo dijo' },
        },
        required: ['profesional', 'servicio', 'fecha', 'hora'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'set_patient_name',
      description:
        'Cuando el paciente dice su nombre ("Salvador", "me llamo María") y falta nombre en la reserva (needNombre o draft.nombre=-). Guarda el nombre y avanza.',
      parameters: {
        type: 'object',
        properties: {
          nombre: {
            type: 'string',
            description: 'Nombre y apellido del paciente (sin frases)',
          },
        },
        required: ['nombre'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'confirm_booking',
      description:
        'Cuando el paciente confirma el turno trabado ("sí", "dale", "confirmo") o lo cancela. Ejecuta la reserva real. No digas que quedó reservado sin llamar esta tool.',
      parameters: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            description: 'true para confirmar; false si cancela el armado',
          },
        },
        required: ['confirm'],
      },
    },
  },
];

export const ASSISTANT_TOOL_NAMES = ASSISTANT_TOOL_DEFINITIONS.map(t => t.function.name);

/** Tools activas para un turno (omite disabledTools). */
export function getActiveToolDefinitions(disabledTools?: string[] | null) {
  if (!disabledTools?.length) return ASSISTANT_TOOL_DEFINITIONS;
  const blocked = new Set(disabledTools);
  return ASSISTANT_TOOL_DEFINITIONS.filter(t => !blocked.has(t.function.name));
}
