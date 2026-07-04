import { google } from 'googleapis';

// Configure Google Calendar using Service Account
export const getCalendarClient = async () => {
  // Parse service account key from environment variable
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

// Verificar disponibilidad en Google Calendar
export const verificarDisponibilidadCalendar = async (
  fechaStr: string,
  horaStr: string
) => {
  try {
    const calendar = await getCalendarClient();
    const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

    // Convertir fecha y hora a ISO
    const [year, month, day] = fechaStr.split('-').map(Number);
    const [hour, minute] = horaStr.split(':').map(Number);

    const start = new Date(year, month - 1, day, hour, minute);
    const end = new Date(start.getTime() + 60 * 60 * 1000); // 1 hora de duración

    const response = await calendar.events.list({
      calendarId,
      timeMin: start.toISOString(),
      timeMax: end.toISOString(),
      singleEvents: true,
      orderBy: 'startTime',
    });

    const events = response.data.items || [];
    if (events.length > 0) {
      return { disponible: false, mensaje: 'Lo siento, ese horario ya está ocupado en Google Calendar.' };
    }

    return { disponible: true };
  } catch (error) {
    console.error('Error al verificar disponibilidad en Google Calendar:', error);
    return { disponible: false, mensaje: 'Error al verificar disponibilidad. Intenta más tarde.' };
  }
};

// Crear evento en Google Calendar
export const crearEventoCalendar = async (datosReserva: any) => {
  try {
    const calendar = await getCalendarClient();
    const calendarId = process.env.GOOGLE_CALENDAR_ID || 'primary';

    const [year, month, day] = datosReserva.fecha.split('-').map(Number);
    const [hour, minute] = datosReserva.hora.split(':').map(Number);

    const start = new Date(year, month - 1, day, hour, minute);
    const end = new Date(start.getTime() + 60 * 60 * 1000); // 1 hora de duración

    const event = {
      summary: `${datosReserva.servicio} - ${datosReserva.nombre}`,
      description: `Reserva de ${datosReserva.nombre} para ${datosReserva.servicio}`,
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

    return { success: true, eventId: response.data.id };
  } catch (error) {
    console.error('Error al crear evento en Google Calendar:', error);
    return { success: false };
  }
};
