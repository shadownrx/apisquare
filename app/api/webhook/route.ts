import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import { createClient } from '@vercel/kv';
import { getLocalReservations, addLocalReservation } from '../admin/reservations/route';

interface ConversationState {
  paso?: string | null;
  servicio?: string;
  nombre?: string;
  fecha?: string;
}

interface Reservation {
  id: string;
  servicio: string;
  nombre: string;
  fecha: string;
  hora: string;
  chatId: number;
}

// Inicializar cliente de Vercel KV con manejo de errores
let kv: any = null;
try {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    kv = createClient({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
  }
} catch (e) {
  console.log('KV not available locally, using memory storage');
}

// Almacenamiento en memoria para desarrollo local
const localStorage = new Map();

// Lista de servicios disponibles
const servicios = [
  'Sesión de Quiropráctica',
  'Masaje Relajante',
  'Traumatología'
];

// Horarios disponibles (ejemplo: Lunes a Viernes de 9:00 a 18:00, turnos de 60 min)
const horariosDisponibles = [
  '09:00', '10:00', '11:00', '12:00',
  '13:00', '14:00', '15:00', '16:00', '17:00'
];
const diasLaborables = [1, 2, 3, 4, 5]; // Lunes (1) a Viernes (5)

// Función para formatear fecha de forma legible
function formatDate(fechaStr: string): string {
  const fecha = new Date(fechaStr + 'T12:00:00');
  const options: Intl.DateTimeFormatOptions = {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  };
  return fecha.toLocaleDateString('es-ES', options);
}

function toDateStr(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function proximosDiasLaborables(cantidad: number): { fecha: string; label: string }[] {
  const dias: { fecha: string; label: string }[] = [];
  const today = getToday();
  let offset = 0;

  while (dias.length < cantidad && offset < 30) {
    const candidate = addDays(today, offset);
    if (diasLaborables.includes(candidate.getDay())) {
      let label: string;
      if (offset === 0) label = 'Hoy';
      else if (offset === 1) label = 'Mañana';
      else {
        label = candidate.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
        label = label.charAt(0).toUpperCase() + label.slice(1);
      }
      dias.push({ fecha: toDateStr(candidate), label });
    }
    offset++;
  }
  return dias;
}

function buildFechasKeyboard() {
  const dias = proximosDiasLaborables(8);
  const keyboard = [];
  for (let i = 0; i < dias.length; i += 2) {
    keyboard.push(
      dias.slice(i, i + 2).map(d => ({
        text: d.label,
        callback_data: `fecha:${d.fecha}`
      }))
    );
  }
  keyboard.push([{ text: '🏠 Menú', callback_data: 'menu' }]);
  return keyboard;
}

function buildFechasView(servicio?: string) {
  return {
    text: servicio
      ? `¿Qué día preferís para ${servicio}?`
      : '¿Qué día te gustaría?',
    keyboard: buildFechasKeyboard()
  };
}

function parseFecha(text: string): string | null {
  const normalized = text.toLowerCase().trim();
  const today = getToday();

  if (['hoy', 'today'].includes(normalized)) return toDateStr(today);
  if (['mañana', 'manana', 'tomorrow'].includes(normalized)) return toDateStr(addDays(today, 1));
  if (['pasado mañana', 'pasado manana'].includes(normalized)) return toDateStr(addDays(today, 2));

  if (/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return normalized;

  const slashMatch = normalized.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/);
  if (slashMatch) {
    const day = parseInt(slashMatch[1], 10);
    const month = parseInt(slashMatch[2], 10);
    const year = slashMatch[3] ? parseInt(slashMatch[3], 10) : today.getFullYear();
    const d = new Date(year, month - 1, day);
    if (!isNaN(d.getTime())) return toDateStr(d);
  }

  return null;
}

function esDiaLaborable(fechaStr: string): boolean {
  const dia = new Date(fechaStr + 'T12:00:00').getDay();
  return diasLaborables.includes(dia);
}

// Función para generar ID único
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function reservaKey(servicio: string, fechaStr: string, horaStr: string): string {
  return `reserva:${servicio}:${fechaStr}:${horaStr}`;
}

async function obtenerReservaEnSlot(servicio: string, fechaStr: string, horaStr: string): Promise<Reservation | null> {
  if (kv) {
    const data = await kv.get(reservaKey(servicio, fechaStr, horaStr));
    if (data) {
      return typeof data === 'string' ? JSON.parse(data) : data;
    }
    return null;
  }

  const localReservations = getLocalReservations();
  return localReservations.find(
    r => r.servicio === servicio && r.fecha === fechaStr && r.hora === horaStr
  ) ?? null;
}

async function obtenerHorariosLibres(fechaStr: string, servicio: string): Promise<string[]> {
  const libres: string[] = [];
  for (const hora of horariosDisponibles) {
    const ocupado = await obtenerReservaEnSlot(servicio, fechaStr, hora);
    if (!ocupado) libres.push(hora);
  }
  return libres;
}

function otrasEspecialidadesKeyboard(servicioActual: string) {
  const keyboard = servicios
    .filter(s => s !== servicioActual)
    .map(s => [{ text: s, callback_data: `servicio:${s}` }]);
  keyboard.push(
    [{ text: '🔄 Otros horarios', callback_data: 'refresh_horarios' }],
    [{ text: '📅 Otra fecha', callback_data: 'cambiar_fecha' }]
  );
  return keyboard;
}

async function buildHorariosView(fechaStr: string, servicio: string) {
  const horariosLibres = await obtenerHorariosLibres(fechaStr, servicio);

  if (horariosLibres.length === 0) {
    const otras = servicios.filter(s => s !== servicio);
    return {
      text:
        `No hay turnos libres para ${servicio} el ${formatDate(fechaStr)}.\n\n` +
        `Otra especialidad puede tener disponibilidad ese día:`,
      keyboard: [
        ...otras.map(s => [{ text: s, callback_data: `servicio:${s}` }]),
        [{ text: '📅 Elegir otra fecha', callback_data: 'cambiar_fecha' }],
        [{ text: '🏠 Menú', callback_data: 'menu' }]
      ]
    };
  }

  const keyboard = [];
  for (let i = 0; i < horariosLibres.length; i += 3) {
    keyboard.push(
      horariosLibres.slice(i, i + 3).map(h => ({ text: h, callback_data: `hora:${h}` }))
    );
  }

  return {
    text: `Turnos disponibles para ${servicio} (${formatDate(fechaStr)}):`,
    keyboard
  };
}

async function verificarDisponibilidad(servicio: string, fechaStr: string, horaStr: string) {
  try {
    const fecha = new Date(fechaStr + 'T12:00:00');
    const dia = fecha.getDay();
    
    if (!diasLaborables.includes(dia)) {
      return { disponible: false, mensaje: 'Lo siento, no atendemos ese día.' };
    }
    
    if (!horariosDisponibles.includes(horaStr)) {
      return { disponible: false, mensaje: 'Horario no disponible. Escoge entre: ' + horariosDisponibles.join(', ') };
    }
    
    const reservaExistente = await obtenerReservaEnSlot(servicio, fechaStr, horaStr);
    if (reservaExistente) {
      return {
        disponible: false,
        mensaje: `Ese horario ya está reservado para ${servicio}. Podés elegir otro horario u otra especialidad.`
      };
    }
    
    return { disponible: true };
  } catch (error) {
    console.error('Error al verificar disponibilidad:', error);
    return { disponible: false, mensaje: 'Error al verificar disponibilidad. Intenta más tarde.' };
  }
}

// Función para guardar reserva
async function guardarReserva(chatId: number, datos: Omit<Reservation, 'id'>): Promise<Reservation | null> {
  try {
    const id = generateId();
    const reserva: Reservation = { ...datos, id };
    const key = reservaKey(datos.servicio, datos.fecha, datos.hora);
    const idKey = `reserva:id:${id}`;
    
    if (kv) {
      const existente = await obtenerReservaEnSlot(datos.servicio, datos.fecha, datos.hora);
      if (existente) {
        console.log(`[DUPLICADO EVITADO] Ya existe reserva en ${key}`);
        return null;
      }

      await kv.set(key, JSON.stringify(reserva), { ex: 86400 * 30 });
      await kv.set(idKey, JSON.stringify(reserva), { ex: 86400 * 30 });
      
      // Guardar también por usuario
      const userKey = `user:${chatId}:reservas`;
      const userReservas = await kv.get(userKey) || [];
      const reservasArray = Array.isArray(userReservas) ? userReservas : JSON.parse(userReservas as string);
      reservasArray.push(reserva);
      await kv.set(userKey, JSON.stringify(reservasArray));
    } else {
      // Almacenar en memoria para desarrollo local
      const existente = await obtenerReservaEnSlot(datos.servicio, datos.fecha, datos.hora);
      if (existente) {
        console.log(`[DUPLICADO EVITADO LOCAL] Ya existe reserva en ${datos.fecha} ${datos.hora}`);
        return null;
      }
      addLocalReservation(reserva);
    }
    
    return reserva;
  } catch (error) {
    console.error('Error al guardar reserva:', error);
    return null;
  }
}

// Función para eliminar reserva
async function eliminarReserva(chatId: number, reservaId: string) {
  try {
    if (kv) {
      // Obtener la reserva primero para conocer fecha, hora y servicio
      const idKey = `reserva:id:${reservaId}`;
      const reservaData = await kv.get(idKey);
      if (!reservaData) return false;
      
      const reserva = typeof reservaData === 'string' ? JSON.parse(reservaData) : reservaData;
      
      await kv.del(reservaKey(reserva.servicio, reserva.fecha, reserva.hora));
      await kv.del(idKey);
      
      // Eliminar de la lista del usuario
      const userKey = `user:${chatId}:reservas`;
      const userReservas = await kv.get(userKey) || [];
      let reservasArray = Array.isArray(userReservas) ? userReservas : JSON.parse(userReservas as string);
      reservasArray = reservasArray.filter((r: Reservation) => r.id !== reservaId);
      await kv.set(userKey, JSON.stringify(reservasArray));
    } else {
      // Eliminar de memoria local
      const localReservations = getLocalReservations();
      const index = localReservations.findIndex(r => r.id === reservaId);
      if (index !== -1) {
        localReservations.splice(index, 1);
      }
    }
    
    return true;
  } catch (error) {
    console.error('Error al eliminar reserva:', error);
    return false;
  }
}

export async function POST(request: NextRequest) {
  console.log('=== NUEVA SOLICITUD ===');

  try {
    const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

    console.log('TELEGRAM_TOKEN presente:', !!TELEGRAM_TOKEN);
    console.log('KV configurado:', !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN));

    const update = await request.json();
    console.log('Update completo:', JSON.stringify(update, null, 2));

    // Manejar callback queries (presionar botones)
    if (update.callback_query) {
      const callbackQuery = update.callback_query;
      const chatId = callbackQuery.message.chat.id;
      const data = callbackQuery.data;

      // Obtener estado de conversación
      const estadoKey = `conv:${chatId}`;
      let estado: ConversationState = { paso: null };
      
      if (kv) {
        const kvEstado = await kv.get(estadoKey);
        estado = kvEstado || { paso: null };
        if (typeof estado === 'string') estado = JSON.parse(estado);
      } else {
        estado = localStorage.get(estadoKey) || { paso: null };
      }

      // Helper para guardar estado
      const saveState = async (newState: ConversationState) => {
        estado = newState;
        if (kv) {
          await kv.set(estadoKey, JSON.stringify(estado));
        } else {
          localStorage.set(estadoKey, estado);
        }
      };

      // Helper para enviar mensajes con botones
      const sendWithKeyboard = async (t: string, keyboard: any = null) => {
        console.log('Enviando mensaje a Telegram:', t.substring(0, 100) + '...');
        try {
          const payload: any = {
            chat_id: chatId,
            text: t
          };
          if (keyboard) {
            payload.reply_markup = { inline_keyboard: keyboard };
          }
          const response = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, payload);
          console.log('✅ Mensaje enviado exitosamente! Status:', response.status);
        } catch (e: any) {
          console.error('❌ Error al enviar mensaje:', e.message);
          if (e.response) {
            console.error('Response data:', JSON.stringify(e.response.data, null, 2));
          }
        }
      };

      // Responder al callback para quitar el "cargando"
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
        callback_query_id: callbackQuery.id
      });

      // Manejar diferentes callbacks
      if (data === 'servicios') {
        await sendWithKeyboard(
          'Estos son los servicios disponibles:',
          servicios.map(s => [{ text: s, callback_data: `servicio:${s}` }])
        );
      } else if (data === 'reservar') {
        await saveState({ paso: 'servicio' });
        await sendWithKeyboard(
          '¿Qué servicio te gustaría reservar?',
          servicios.map(s => [{ text: s, callback_data: `servicio:${s}` }])
        );
      } else if (data === 'misreservas') {
        let reservasArray: Reservation[] = [];
        
        if (kv) {
          const userReservasKey = `user:${chatId}:reservas`;
          const userReservas = await kv.get(userReservasKey) || [];
          reservasArray = Array.isArray(userReservas) ? userReservas : JSON.parse(userReservas as string);
        } else {
          const localReservations = getLocalReservations();
          reservasArray = localReservations.filter(r => r.chatId === chatId);
        }
        
        if (reservasArray.length === 0) {
          await sendWithKeyboard(
            'Todavía no tienes reservas. ¿Quieres hacer una?',
            [
              [{ text: '✅ Sí, reservar', callback_data: 'reservar' }],
              [{ text: '🏠 Menú', callback_data: 'menu' }]
            ]
          );
        } else {
          // Mostrar reservas con botones de eliminar
          const keyboard = reservasArray.map((r: Reservation) => [
            { text: `${r.servicio} - ${formatDate(r.fecha)} ${r.hora}`, callback_data: 'noop' },
            { text: '❌ Eliminar', callback_data: `eliminar:${r.id}` }
          ]);
          keyboard.push([{ text: '🏠 Menú', callback_data: 'menu' }]);
          
          await sendWithKeyboard('Tus reservas:', keyboard);
        }
      } else if (data.startsWith('eliminar:')) {
        const reservaId = data.replace('eliminar:', '');
        const eliminado = await eliminarReserva(chatId, reservaId);
        
        if (eliminado) {
          await sendWithKeyboard(
            'Reserva eliminada correctamente!',
            [
              [{ text: '📋 Mis reservas', callback_data: 'misreservas' }],
              [{ text: '🏠 Menú', callback_data: 'menu' }]
            ]
          );
        } else {
          await sendWithKeyboard(
            'Ups, no se pudo eliminar la reserva.',
            [[{ text: '🏠 Menú', callback_data: 'menu' }]]
          );
        }
      } else if (data === 'menu') {
        await saveState({ paso: null });
        await sendWithKeyboard('Hola 👋 ¿Qué necesitas?', [
          [{ text: '📋 Ver servicios', callback_data: 'servicios' }],
          [{ text: '📅 Reservar', callback_data: 'reservar' }],
          [{ text: '📋 Mis reservas', callback_data: 'misreservas' }]
        ]);
      } else if (data.startsWith('servicio:')) {
        const servicioSeleccionado = data.replace('servicio:', '');
        if (estado.nombre && estado.fecha) {
          await saveState({ ...estado, paso: 'hora', servicio: servicioSeleccionado });
          const view = await buildHorariosView(estado.fecha, servicioSeleccionado);
          await sendWithKeyboard(view.text, view.keyboard);
        } else {
          await saveState({ paso: 'nombre', servicio: servicioSeleccionado });
          await sendWithKeyboard(`${servicioSeleccionado} ✔️ ¿Cuál es tu nombre?`);
        }
      } else if (data === 'cambiar_fecha') {
        await saveState({ paso: 'fecha', servicio: estado.servicio, nombre: estado.nombre });
        const view = buildFechasView(estado.servicio);
        await sendWithKeyboard(view.text, view.keyboard);
      } else if (data.startsWith('fecha:')) {
        const fechaSeleccionada = data.replace('fecha:', '');
        if (estado.servicio) {
          await saveState({ ...estado, paso: 'hora', fecha: fechaSeleccionada });
          const view = await buildHorariosView(fechaSeleccionada, estado.servicio);
          await sendWithKeyboard(view.text, view.keyboard);
        }
      } else if (data === 'refresh_horarios') {
        if (estado.fecha && estado.servicio) {
          const view = await buildHorariosView(estado.fecha, estado.servicio);
          await sendWithKeyboard(view.text, view.keyboard);
        }
      } else if (data.startsWith('hora:')) {
        const horaSeleccionada = data.replace('hora:', '');
        const disponibilidad = await verificarDisponibilidad(estado.servicio!, estado.fecha!, horaSeleccionada);
            
        if (disponibilidad.disponible) {
          // Guardar reserva
          const datosReserva = {
            servicio: estado.servicio!,
            nombre: estado.nombre!,
            fecha: estado.fecha!,
            hora: horaSeleccionada,
            chatId: chatId
          };
          
          const reserva = await guardarReserva(chatId, datosReserva);
          
          if (reserva) {
            await saveState({ paso: null });
            await sendWithKeyboard(
              `Listo! Tu reserva está confirmada:\n\n` +
              `✨ ${reserva.servicio}\n` +
              `📅 ${formatDate(reserva.fecha)}\n` +
              `🕐 ${reserva.hora}\n\n` +
              `¡Nos vemos! 😊`,
              [
                [{ text: '📋 Mis reservas', callback_data: 'misreservas' }],
                [{ text: '🏠 Menú', callback_data: 'menu' }]
              ]
            );
          } else {
            await sendWithKeyboard(
              `Ese horario para ${estado.servicio} acaba de ser reservado.`,
              otrasEspecialidadesKeyboard(estado.servicio!)
            );
          }
        } else {
          await sendWithKeyboard(
            disponibilidad.mensaje || 'Lo siento, ese horario no está disponible.',
            otrasEspecialidadesKeyboard(estado.servicio!)
          );
        }
      } else if (data === 'noop') {
        // No hacer nada
      }
      
      return NextResponse.json({ status: 'ok' });
    }

    // Si es un mensaje de texto normal
    if (update && update.message) {
      const msg = update.message;
      const text = msg.text || '';
      const chatId = msg.chat.id;

      console.log('Mensaje de texto:', text);
      console.log('Chat ID:', chatId);

      // Obtener estado de conversación desde KV o memoria
      const estadoKey = `conv:${chatId}`;
      let estado: ConversationState = { paso: null };
      
      if (kv) {
        const kvEstado = await kv.get(estadoKey);
        estado = kvEstado || { paso: null };
        if (typeof estado === 'string') estado = JSON.parse(estado);
      } else {
        estado = localStorage.get(estadoKey) || { paso: null };
      }

      // Helper para guardar estado
      const saveState = async (newState: ConversationState) => {
        estado = newState;
        if (kv) {
          await kv.set(estadoKey, JSON.stringify(estado));
        } else {
          localStorage.set(estadoKey, estado);
        }
      };

      // Helper para enviar mensajes con botones
      const sendWithKeyboard = async (t: string, keyboard: any = null) => {
        console.log('Enviando mensaje a Telegram:', t.substring(0, 100) + '...');
        try {
          const payload: any = {
            chat_id: chatId,
            text: t
          };
          if (keyboard) {
            payload.reply_markup = { inline_keyboard: keyboard };
          }
          const response = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, payload);
          console.log('✅ Mensaje enviado exitosamente! Status:', response.status);
        } catch (e: any) {
          console.error('❌ Error al enviar mensaje:', e.message);
          if (e.response) {
            console.error('Response data:', JSON.stringify(e.response.data, null, 2));
          }
        }
      };

      // Helper para mostrar el menú principal
      const showMainMenu = async () => {
        await sendWithKeyboard('Hola 👋 ¿Qué necesitas?', [
          [{ text: '📋 Ver servicios', callback_data: 'servicios' }],
          [{ text: '📅 Reservar', callback_data: 'reservar' }],
          [{ text: '📋 Mis reservas', callback_data: 'misreservas' }]
        ]);
      };

      // Helper para mostrar servicios con botones
      const showServices = async () => {
        await sendWithKeyboard(
          'Estos son los servicios disponibles:',
          servicios.map(s => [{ text: s, callback_data: `servicio:${s}` }])
        );
      };

      // Helper para mostrar solo horarios libres en la fecha elegida
      const showHorarios = async (fechaStr: string, servicio: string) => {
        await saveState({
          paso: 'hora',
          servicio,
          nombre: estado.nombre,
          fecha: fechaStr
        });
        const view = await buildHorariosView(fechaStr, servicio);
        await sendWithKeyboard(view.text, view.keyboard);
      };

      // Comandos conversacionales (con y sin "/")
      const normalizedText = text.toLowerCase().trim();
      
      if (['/start', 'start', 'hola', 'hello', 'buenos días', 'buenas tardes', 'buenas noches', 'hey'].includes(normalizedText)) {
        await saveState({ paso: null });
        await showMainMenu();
      }

      else if (['/servicios', 'servicios', 'servicio', '/categorias', 'categorias', 'categoria', 'que servicios hay'].includes(normalizedText)) {
        await showServices();
      }

      else if (['/misreservas', 'mis reservas', 'misreservas', 'reservas', 'ver reservas', 'ver mis reservas'].includes(normalizedText)) {
        let reservasArray: Reservation[] = [];
        
        if (kv) {
          const userReservasKey = `user:${chatId}:reservas`;
          const userReservas = await kv.get(userReservasKey) || [];
          reservasArray = Array.isArray(userReservas) ? userReservas : JSON.parse(userReservas as string);
        } else {
          const localReservations = getLocalReservations();
          reservasArray = localReservations.filter(r => r.chatId === chatId);
        }
        
        if (reservasArray.length === 0) {
          await sendWithKeyboard(
            'Todavía no tienes reservas. ¿Quieres hacer una?',
            [
              [{ text: '✅ Sí, reservar', callback_data: 'reservar' }],
              [{ text: '🏠 Menú', callback_data: 'menu' }]
            ]
          );
        } else {
          // Mostrar reservas con botones de eliminar
          const keyboard = reservasArray.map((r: Reservation) => [
            { text: `${r.servicio} - ${formatDate(r.fecha)} ${r.hora}`, callback_data: 'noop' },
            { text: '❌ Eliminar', callback_data: `eliminar:${r.id}` }
          ]);
          keyboard.push([{ text: '🏠 Menú', callback_data: 'menu' }]);
          
          await sendWithKeyboard('Tus reservas:', keyboard);
        }
      }

      else if (['/reservar', 'reservar', 'reservar turno', 'quiero reservar', 'agendar', 'quiero agendar', 'hacer una reserva'].includes(normalizedText)) {
        await saveState({ paso: 'servicio' });
        await sendWithKeyboard(
          '¿Qué servicio te gustaría reservar?',
          servicios.map(s => [{ text: s, callback_data: `servicio:${s}` }])
        );
      }

      // Manejo del flujo conversacional
      else if (estado && estado.paso) {
        console.log('Estado de conversación:', estado);

        // Paso 1: Seleccionar servicio (si no es por botón)
        if (estado.paso === 'servicio') {
          let servicioSeleccionado = null;
          
          // Intentar encontrar por número
          const num = parseInt(text);
          if (!isNaN(num) && num >= 1 && num <= servicios.length) {
            servicioSeleccionado = servicios[num - 1];
          }
          
          // Intentar encontrar por nombre
          else {
            servicioSeleccionado = servicios.find(s => 
              s.toLowerCase().includes(text.toLowerCase())
            );
          }

          if (servicioSeleccionado) {
            await saveState({
              paso: 'nombre',
              servicio: servicioSeleccionado
            });
            await sendWithKeyboard(`${servicioSeleccionado} ✔️ ¿Cuál es tu nombre?`);
          } else {
            await sendWithKeyboard('No reconozco ese servicio. Por favor elige uno:', servicios.map(s => [{ text: s, callback_data: `servicio:${s}` }]));
          }
        }

        // Paso 2: Obtener nombre
        else if (estado.paso === 'nombre') {
          await saveState({
            paso: 'fecha',
            servicio: estado.servicio,
            nombre: text
          });
          const view = buildFechasView(estado.servicio);
          await sendWithKeyboard(`Hola ${text} 👋 ${view.text}`, view.keyboard);
        }

        // Paso 3: Obtener fecha
        else if (estado.paso === 'fecha') {
          const fechaParseada = parseFecha(text);
          if (fechaParseada && esDiaLaborable(fechaParseada)) {
            await showHorarios(fechaParseada, estado.servicio!);
          } else if (fechaParseada && !esDiaLaborable(fechaParseada)) {
            await sendWithKeyboard(
              'No atendemos fines de semana. Elegí un día de lunes a viernes:',
              buildFechasKeyboard()
            );
          } else {
            const view = buildFechasView(estado.servicio);
            await sendWithKeyboard('Elegí un día de la lista:', view.keyboard);
          }
        }

        // Paso 4: Obtener hora y confirmar (si no es por botón)
        else if (estado.paso === 'hora') {
          let horaSeleccionada = null;
          const horariosLibres = await obtenerHorariosLibres(estado.fecha!, estado.servicio!);
          
          const num = parseInt(text);
          if (!isNaN(num) && num >= 1 && num <= horariosLibres.length) {
            horaSeleccionada = horariosLibres[num - 1];
          } else {
            horaSeleccionada = horariosLibres.find(h => 
              h.includes(text) || text.includes(h)
            ) ?? null;
          }

          if (horaSeleccionada) {
            const disponibilidad = await verificarDisponibilidad(estado.servicio!, estado.fecha!, horaSeleccionada);
            
            if (disponibilidad.disponible) {
              const datosReserva = {
                servicio: estado.servicio!,
                nombre: estado.nombre!,
                fecha: estado.fecha!,
                hora: horaSeleccionada,
                chatId: chatId
              };
              
              const reserva = await guardarReserva(chatId, datosReserva);
              
              if (reserva) {
                await saveState({ paso: null });
                await sendWithKeyboard(
                  `Listo! Tu reserva está confirmada:\n\n` +
                  `✨ ${reserva.servicio}\n` +
                  `📅 ${formatDate(reserva.fecha)}\n` +
                  `🕐 ${reserva.hora}\n\n` +
                  `¡Nos vemos! 😊`,
                  [
                    [{ text: '📋 Mis reservas', callback_data: 'misreservas' }],
                    [{ text: '🏠 Menú', callback_data: 'menu' }]
                  ]
                );
              } else {
                await sendWithKeyboard(
                  `Ese horario para ${estado.servicio} acaba de ser reservado.`,
                  otrasEspecialidadesKeyboard(estado.servicio!)
                );
              }
            } else {
              await sendWithKeyboard(
                disponibilidad.mensaje || 'Lo siento, ese horario no está disponible.',
                otrasEspecialidadesKeyboard(estado.servicio!)
              );
            }
          } else {
            await showHorarios(estado.fecha!, estado.servicio!);
          }
        }
      }

      // Mensaje cualquiera sin estado
      else {
        await showMainMenu();
      }
    }

    // Respondemos a Vercel
    console.log('=== FINALIZANDO - Respondiendo a Vercel ===');
    return NextResponse.json({ status: 'ok' });
  } catch (error) {
    console.error('=== ERROR GRAVE ===');
    console.error('Error:', error);
    return NextResponse.json({ status: 'ok' });
  }
}

export async function GET() {
  return NextResponse.json({ status: 'ok' });
}
