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

// Función para verificar disponibilidad (solo con KV)
async function verificarDisponibilidad(fechaStr: string, horaStr: string) {
  try {
    const fecha = new Date(fechaStr);
    const dia = fecha.getDay();
    
    // 1. Verificar si es día laborable
    if (!diasLaborables.includes(dia)) {
      return { disponible: false, mensaje: 'Lo siento, no atendemos ese día.' };
    }
    
    // 2. Verificar si el horario está disponible
    if (!horariosDisponibles.includes(horaStr)) {
      return { disponible: false, mensaje: 'Horario no disponible. Escoge entre: ' + horariosDisponibles.join(', ') };
    }
    
    // 3. Verificar en la BD si ya está reservado
    const key = `reserva:${fechaStr}:${horaStr}`;
    let reservaExistente = null;
    
    if (kv) {
      reservaExistente = await kv.get(key);
    } else {
      const localReservations = getLocalReservations();
      reservaExistente = localReservations.find(r => r.fecha === fechaStr && r.hora === horaStr);
    }
    
    if (reservaExistente) {
      return { disponible: false, mensaje: 'Lo siento, ese horario ya está reservado.' };
    }
    
    return { disponible: true };
  } catch (error) {
    console.error('Error al verificar disponibilidad:', error);
    return { disponible: false, mensaje: 'Error al verificar disponibilidad. Intenta más tarde.' };
  }
}

// Función para guardar reserva
async function guardarReserva(chatId: number, datos: any) {
  try {
    const key = `reserva:${datos.fecha}:${datos.hora}`;
    
    if (kv) {
      await kv.set(key, JSON.stringify(datos), { ex: 86400 * 30 }); // Expirar en 30 días
      
      // Guardar también por usuario
      const userKey = `user:${chatId}:reservas`;
      const userReservas = await kv.get(userKey) || [];
      const reservasArray = Array.isArray(userReservas) ? userReservas : JSON.parse(userReservas as string);
      reservasArray.push(datos);
      await kv.set(userKey, JSON.stringify(reservasArray));
    } else {
      // Almacenar en memoria para desarrollo local
      addLocalReservation(datos);
    }
    
    return true;
  } catch (error) {
    console.error('Error al guardar reserva:', error);
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
        let reservasArray: any[] = [];
        
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
          let mensaje = 'Tus reservas:\n';
          reservasArray.forEach((r: any, i: number) => {
            mensaje += `${i + 1}. ${r.servicio} - ${r.fecha} ${r.hora}\n`;
          });
          await sendWithKeyboard(mensaje, [[{ text: '🏠 Menú', callback_data: 'menu' }]]);
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
        const disponibilidad = await verificarDisponibilidad(estado.fecha!, horaSeleccionada);
            
        if (disponibilidad.disponible) {
          // Guardar reserva
          const datosReserva = {
            servicio: estado.servicio,
            nombre: estado.nombre,
            fecha: estado.fecha,
            hora: horaSeleccionada,
            chatId: chatId
          };
          
          const guardado = await guardarReserva(chatId, datosReserva);
          
          if (guardado) {
            await saveState({ paso: null });
            await sendWithKeyboard(`Listo! Tu reserva está confirmada:\n\n${datosReserva.servicio}\n${datosReserva.fecha} ${datosReserva.hora}\n\n¡Nos vemos! 😊`, [[{ text: '🏠 Menú', callback_data: 'menu' }]]);
          } else {
            await sendWithKeyboard('Ups, hubo un error. ¿Quieres intentar de nuevo?', [[{ text: '🔄 Sí', callback_data: 'reservar' }]]);
          }
        } else {
          await sendWithKeyboard(`Lo siento, ese horario no está disponible. ¿Quieres elegir otro?`, [[{ text: '🔄 Sí, otro horario', callback_data: 'reservar' }]]);
        }
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

      // Helper para mostrar horarios con botones
      const showHorarios = async () => {
        const keyboard = [];
        for (let i = 0; i < horariosDisponibles.length; i += 3) {
          keyboard.push([
            horariosDisponibles[i], horariosDisponibles[i+1], horariosDisponibles[i+2]
          ].filter(Boolean).map(h => ({ text: h, callback_data: `hora:${h}` })));
        }
        await sendWithKeyboard(
          '¿Qué horario te conviene?',
          keyboard
        );
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
        let reservasArray: any[] = [];
        
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
          let mensaje = 'Tus reservas:\n';
          reservasArray.forEach((r: any, i: number) => {
            mensaje += `${i + 1}. ${r.servicio} - ${r.fecha} ${r.hora}\n`;
          });
          await sendWithKeyboard(mensaje, [[{ text: '🏠 Menú', callback_data: 'menu' }]]);
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
          await showHorarios();
        }

        // Paso 4: Obtener hora y confirmar (si no es por botón)
        else if (estado.paso === 'hora') {
          let horaSeleccionada = null;
          
          // Intentar encontrar por número
          const num = parseInt(text);
          if (!isNaN(num) && num >= 1 && num <= horariosDisponibles.length) {
            horaSeleccionada = horariosDisponibles[num - 1];
          }
          
          // Intentar encontrar por texto
          else {
            horaSeleccionada = horariosDisponibles.find(h => 
              h.includes(text) || text.includes(h)
            );
          }

          if (horaSeleccionada) {
            const disponibilidad = await verificarDisponibilidad(estado.fecha!, horaSeleccionada);
            
            if (disponibilidad.disponible) {
              const datosReserva = {
                servicio: estado.servicio,
                nombre: estado.nombre,
                fecha: estado.fecha,
                hora: horaSeleccionada,
                chatId: chatId
              };
              
              const guardado = await guardarReserva(chatId, datosReserva);
              
              if (guardado) {
                await saveState({ paso: null });
                await sendWithKeyboard(`Listo! Tu reserva está confirmada:\n\n${datosReserva.servicio}\n${datosReserva.fecha} ${datosReserva.hora}\n\n¡Nos vemos! 😊`, [[{ text: '🏠 Menú', callback_data: 'menu' }]]);
              } else {
                await sendWithKeyboard('Ups, hubo un error. ¿Quieres intentar de nuevo?', [[{ text: '🔄 Sí', callback_data: 'reservar' }]]);
              }
            } else {
              await sendWithKeyboard(`Lo siento, ese horario no está disponible. ¿Quieres elegir otro?`, [[{ text: '🔄 Sí, otro horario', callback_data: 'reservar' }]]);
            }
          } else {
            await showHorarios();
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
