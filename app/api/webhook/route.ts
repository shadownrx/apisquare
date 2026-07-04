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

// Función para generar ID único
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function slotKey(fechaStr: string, horaStr: string): string {
  return `reserva:slot:${fechaStr}:${horaStr}`;
}

function legacySlotKey(servicio: string, fechaStr: string, horaStr: string): string {
  return `reserva:${servicio}:${fechaStr}:${horaStr}`;
}

async function obtenerReservaEnSlot(fechaStr: string, horaStr: string): Promise<Reservation | null> {
  if (kv) {
    const data = await kv.get(slotKey(fechaStr, horaStr));
    if (data) {
      return typeof data === 'string' ? JSON.parse(data) : data;
    }
    // Compatibilidad con reservas guardadas con el formato anterior
    for (const servicio of servicios) {
      const legacy = await kv.get(legacySlotKey(servicio, fechaStr, horaStr));
      if (legacy) {
        return typeof legacy === 'string' ? JSON.parse(legacy) : legacy;
      }
    }
    return null;
  }

  const localReservations = getLocalReservations();
  return localReservations.find(r => r.fecha === fechaStr && r.hora === horaStr) ?? null;
}

async function obtenerHorariosLibres(fechaStr: string): Promise<string[]> {
  const libres: string[] = [];
  for (const hora of horariosDisponibles) {
    const ocupado = await obtenerReservaEnSlot(fechaStr, hora);
    if (!ocupado) libres.push(hora);
  }
  return libres;
}

// Verifica que el turno esté libre (un solo turno por fecha+hora, sin importar la especialidad)
async function verificarDisponibilidad(_servicio: string, fechaStr: string, horaStr: string) {
  try {
    const fecha = new Date(fechaStr);
    const dia = fecha.getDay();
    
    if (!diasLaborables.includes(dia)) {
      return { disponible: false, mensaje: 'Lo siento, no atendemos ese día.' };
    }
    
    if (!horariosDisponibles.includes(horaStr)) {
      return { disponible: false, mensaje: 'Horario no disponible. Escoge entre: ' + horariosDisponibles.join(', ') };
    }
    
    const reservaExistente = await obtenerReservaEnSlot(fechaStr, horaStr);
    if (reservaExistente) {
      return {
        disponible: false,
        mensaje: `Lo siento, ese horario (${horaStr}) ya está ocupado. Elegí otro turno disponible.`
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
    const key = slotKey(datos.fecha, datos.hora);
    const idKey = `reserva:id:${id}`;
    
    if (kv) {
      const existente = await obtenerReservaEnSlot(datos.fecha, datos.hora);
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
      const existente = await obtenerReservaEnSlot(datos.fecha, datos.hora);
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
      
      await kv.del(slotKey(reserva.fecha, reserva.hora));
      await kv.del(legacySlotKey(reserva.servicio, reserva.fecha, reserva.hora));
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
        await saveState({ paso: 'nombre', servicio: servicioSeleccionado });
        await sendWithKeyboard(`${servicioSeleccionado} ✔️ ¿Cuál es tu nombre?`);
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
              'Ese horario acaba de ser reservado. ¿Querés elegir otro?',
              [[{ text: '🔄 Sí, otro horario', callback_data: 'reservar' }]]
            );
          }
        } else {
          await sendWithKeyboard(
            disponibilidad.mensaje || 'Lo siento, ese horario no está disponible. ¿Quieres elegir otro?',
            [[{ text: '🔄 Sí, otro horario', callback_data: 'reservar' }]]
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
      const showHorarios = async (fechaStr: string) => {
        const horariosLibres = await obtenerHorariosLibres(fechaStr);

        if (horariosLibres.length === 0) {
          await sendWithKeyboard(
            'No hay turnos disponibles ese día. Probá con otra fecha (AAAA-MM-DD).',
            [[{ text: '🔄 Elegir otra fecha', callback_data: 'reservar' }]]
          );
          await saveState({
            paso: 'fecha',
            servicio: estado.servicio,
            nombre: estado.nombre
          });
          return;
        }

        const keyboard = [];
        for (let i = 0; i < horariosLibres.length; i += 3) {
          keyboard.push(
            horariosLibres.slice(i, i + 3).map(h => ({ text: h, callback_data: `hora:${h}` }))
          );
        }
        await sendWithKeyboard('¿Qué horario te conviene?', keyboard);
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
          await sendWithKeyboard(`Hola ${text} 👋 ¿Qué día te gustaría? (Formato: AAAA-MM-DD)`);
        }

        // Paso 3: Obtener fecha
        else if (estado.paso === 'fecha') {
          await saveState({
            paso: 'hora',
            servicio: estado.servicio,
            nombre: estado.nombre,
            fecha: text
          });
          await showHorarios(text);
        }

        // Paso 4: Obtener hora y confirmar (si no es por botón)
        else if (estado.paso === 'hora') {
          let horaSeleccionada = null;
          const horariosLibres = await obtenerHorariosLibres(estado.fecha!);
          
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
                  'Ese horario acaba de ser reservado. ¿Querés elegir otro?',
                  [[{ text: '🔄 Sí, otro horario', callback_data: 'reservar' }]]
                );
              }
            } else {
              await sendWithKeyboard(
                disponibilidad.mensaje || 'Lo siento, ese horario no está disponible. ¿Quieres elegir otro?',
                [[{ text: '🔄 Sí, otro horario', callback_data: 'reservar' }]]
              );
            }
          } else {
            await showHorarios(estado.fecha!);
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
