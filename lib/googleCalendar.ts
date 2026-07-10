import { google } from 'googleapis';
import type { Reservation } from './types';

export function isCalendarEnabled(): boolean {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY?.trim();
  if (!raw || raw === '{}') return false;

  try {
    const parsed = JSON.parse(raw);
    return Boolean(parsed.client_email && parsed.private_key);
  } catch {
    return false;
  }
}

export const getCalendarClient = async () => {
  const serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '{}');

  const auth = new google.auth.JWT(
    serviceAccountKey.client_email,
    undefined,
    serviceAccountKey.private_key,
    ['https://www.googleapis.com/auth/calendar'],
    undefined
  );

  await auth.authorize();
  return google.calendar({ version: 'v3', auth });
};

function buildEventWindow(fechaStr: string, horaStr: string, duracionMinutos: number) {
  const [year, month, day] = fechaStr.split('-').map(Number);
  const [hour, minute] = horaStr.split(':').map(Number);
  const start = new Date(year, month - 1, day, hour, minute);
  const end = new Date(start.getTime() + duracionMinutos * 60 * 1000);
  return { start, end };
}

export async function verificarDisponibilidadCalendar(
  fechaStr: string,
  horaStr: string,
  duracionMinutos = 60,
  excludeEventId?: string
) {
  if (!isCalendarEnabled()) {
    return { disponible: true as const };
  }

  try {
    const calendar = await getCalendarClient();
    const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
    const { start, end } = buildEventWindow(fechaStr, horaStr, duracionMinutos);

    const response = await calendar.events.list({
      calendarId,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = (response.data.items || []).filter((event) => event.id !== excludeEventId);
    if (events.length > 0) {
      return { disponible: false as const, mensaje: 'Ese horario ya está ocupado en la agenda.' };
    }

    return { disponible: true as const };
  } catch (error) {
    console.error('Error al verificar disponibilidad en Google Calendar:', error);
    return { disponible: true as const };
  }
}

export async function crearEventoCalendar(
  datosReserva: Pick<Reservation, 'servicio' | 'nombre' | 'profesional' | 'fecha' | 'hora'>,
  duracionMinutos = 60
) {
  if (!isCalendarEnabled()) {
    return { success: false as const };
  }

  try {
    const calendar = await getCalendarClient();
    const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
    const { start, end } = buildEventWindow(datosReserva.fecha, datosReserva.hora, duracionMinutos);

    const event = {
      summary: `${datosReserva.servicio} - ${datosReserva.nombre}`,
      description: `Reserva de ${datosReserva.nombre} con ${datosReserva.profesional} (${datosReserva.servicio})`,
      start: {
        dateTime: start.toISOString(),
        timeZone: 'America/Argentina/Buenos_Aires',
      },
      end: {
        dateTime: end.toISOString(),
        timeZone: 'America/Argentina/Buenos_Aires',
      },
    };

    const response = await calendar.events.insert({
      calendarId,
      requestBody: event,
    });

    return { success: true as const, eventId: response.data.id || undefined };
  } catch (error) {
    console.error('Error al crear evento en Google Calendar:', error);
    return { success: false as const };
  }
}

export async function actualizarEventoCalendar(
  eventId: string,
  datosReserva: Pick<Reservation, 'servicio' | 'nombre' | 'profesional' | 'fecha' | 'hora'>,
  duracionMinutos = 60
) {
  if (!isCalendarEnabled() || !eventId) {
    return { success: false as const };
  }

  try {
    const calendar = await getCalendarClient();
    const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
    const { start, end } = buildEventWindow(datosReserva.fecha, datosReserva.hora, duracionMinutos);

    await calendar.events.patch({
      calendarId,
      eventId,
      requestBody: {
        summary: `${datosReserva.servicio} - ${datosReserva.nombre}`,
        description: `Reserva de ${datosReserva.nombre} con ${datosReserva.profesional} (${datosReserva.servicio})`,
        start: {
          dateTime: start.toISOString(),
          timeZone: 'America/Argentina/Buenos_Aires',
        },
        end: {
          dateTime: end.toISOString(),
          timeZone: 'America/Argentina/Buenos_Aires',
        },
      },
    });

    return { success: true as const };
  } catch (error) {
    console.error('Error al actualizar evento en Google Calendar:', error);
    return { success: false as const };
  }
}

export async function eliminarEventoCalendar(eventId?: string) {
  if (!isCalendarEnabled() || !eventId) {
    return { success: false as const };
  }

  try {
    const calendar = await getCalendarClient();
    const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';
    await calendar.events.delete({ calendarId, eventId });
    return { success: true as const };
  } catch (error) {
    console.error('Error al eliminar evento en Google Calendar:', error);
    return { success: false as const };
  }
}

export function getAppointmentDate(reservation: Pick<Reservation, 'fecha' | 'hora'>): Date {
  const [year, month, day] = reservation.fecha.split('-').map(Number);
  const [hour, minute] = reservation.hora.split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute);
}
