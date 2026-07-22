import {
  BTN,
  formatDateShort,
  formatTimeUntilLabel,
  minutesUntilAppointment,
} from '../booking-copy';
import type { Reservation } from '../types';
import type { AppointmentsAction, AssistantKeyboard, ToolExecutionResult } from './types';

export function buildAppointmentsKeyboard(futuras: Reservation[]): AssistantKeyboard {
  const keyboard: AssistantKeyboard = [];

  for (const reservation of futuras) {
    const shortName = reservation.profesional.split(' ')[0];
    const label = `${formatDateShort(reservation.fecha)} · ${reservation.hora} · ${reservation.servicio}`;
    keyboard.push([
      {
        text: label.length > 60 ? label.slice(0, 57) + '…' : label,
        callback_data: `ver_reserva:${reservation.id}`,
      },
    ]);
    keyboard.push([
      { text: `🔄 Cambiar (${shortName})`, callback_data: `reprogramar:${reservation.id}` },
      { text: '❌ Cancelar', callback_data: `confirmar_eliminar:${reservation.id}` },
    ]);
  }

  keyboard.push([BTN.MENU]);
  return keyboard;
}

export function buildAppointmentsToolResult(
  futuras: Reservation[],
  pastCount: number,
  action: AppointmentsAction
): ToolExecutionResult {
  if (futuras.length === 0) {
    return {
      data: {
        count: 0,
        pastCount,
        message:
          pastCount > 0
            ? 'No hay turnos próximos (solo pasados).'
            : 'El paciente no tiene reservas.',
        action,
      },
      keyboard: [[BTN.RESERVAR], [BTN.MENU]],
    };
  }

  if (action === 'change' && futuras.length === 1) {
    return {
      data: {
        count: 1,
        action: 'change',
        appointment: summarize(futuras[0]),
        message: 'Un solo turno: se puede iniciar reprogramación automática.',
      },
      sideEffect: { type: 'start_reschedule', reserva: futuras[0] },
    };
  }

  if (action === 'cancel' && futuras.length === 1) {
    return {
      data: {
        count: 1,
        action: 'cancel',
        appointment: summarize(futuras[0]),
        message: 'Un solo turno: pedir confirmación de cancelación.',
      },
      sideEffect: { type: 'confirm_cancel', reserva: futuras[0] },
    };
  }

  return {
    data: {
      count: futuras.length,
      pastCount,
      action,
      appointments: futuras.map(summarize),
      nextAppointment: summarize(futuras[0]),
      // Hechos crudos: Gemini redacta el mensaje al paciente
      note:
        'Si pregunta cuánto falta, usá minutesUntil / timeUntilLabel del próximo turno y respondé en prosa.',
    },
    keyboard: buildAppointmentsKeyboard(futuras),
  };
}

function summarize(r: Reservation) {
  const minutesUntil = minutesUntilAppointment(r.fecha, r.hora);
  return {
    id: r.id,
    fecha: r.fecha,
    hora: r.hora,
    fechaLabel: formatDateShort(r.fecha),
    profesional: r.profesional,
    servicio: r.servicio,
    nombre: r.nombre,
    minutesUntil,
    timeUntilLabel: formatTimeUntilLabel(minutesUntil),
  };
}
