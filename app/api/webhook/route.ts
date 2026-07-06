import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import { createClient } from '@vercel/kv';
import { getLocalReservations, addLocalReservation } from '../admin/reservations/route';

interface ConversationState {
  paso?: string | null;
  profesional?: string;
  servicio?: string;
  nombre?: string;
  fecha?: string;
  hora?: string; // guardamos la hora elegida para el paso de confirmación
}

interface Reservation {
  id: string;
  profesional: string;
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

// ── Rate limit en memoria local ──────────────────────────────────────────────
const localRateLimit = new Map<number, { count: number; windowStart: number }>();
const RATE_LIMIT_MAX = 20;      // mensajes por ventana
const RATE_LIMIT_WINDOW = 60;   // segundos

async function checkUserRateLimit(chatId: number): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000);

  if (kv) {
    const key = `ratelimit:user:${chatId}`;
    const data = await kv.get(key) as { count: number; windowStart: number } | null;
    if (!data) {
      await kv.set(key, JSON.stringify({ count: 1, windowStart: now }), { ex: RATE_LIMIT_WINDOW });
      return false; // no bloqueado
    }
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    const elapsed = now - parsed.windowStart;

    if (elapsed > RATE_LIMIT_WINDOW) {
      // ventana nueva
      await kv.set(key, JSON.stringify({ count: 1, windowStart: now }), { ex: RATE_LIMIT_WINDOW });
      return false;
    }

    if (parsed.count >= RATE_LIMIT_MAX) {
      return true; // bloqueado
    }

    parsed.count += 1;
    await kv.set(key, JSON.stringify(parsed), { ex: RATE_LIMIT_WINDOW - elapsed });
    return false;
  } else {
    const data = localRateLimit.get(chatId);
    if (!data) {
      localRateLimit.set(chatId, { count: 1, windowStart: now });
      return false;
    }

    const elapsed = now - data.windowStart;
    if (elapsed > RATE_LIMIT_WINDOW) {
      localRateLimit.set(chatId, { count: 1, windowStart: now });
      return false;
    }

    if (data.count >= RATE_LIMIT_MAX) {
      return true;
    }

    data.count += 1;
    return false;
  }
}
// ─────────────────────────────────────────────────────────────────────────────

// Profesionales y Servicios
const PROFESIONALES = ['Francisco Chibilisco', 'Javier Martoni'];

const SERVICIOS = [
  { nombre: 'Sesión de Quiropraxia', duracionMinutos: 25, precio: 30000 },
  { nombre: 'Sesión de Masajes', duracionMinutos: 45, precio: 30000 },
  { nombre: 'Sesión Premium', duracionMinutos: 60, precio: 55000 }
];

function getServicio(nombre: string) {
  return SERVICIOS.find(s => s.nombre.toLowerCase() === nombre.toLowerCase());
}

// Devuelve array de { inicio, fin } para un profesional y día (0=Dom, 1=Lun, ..., 6=Sab)
function getHorarioProfesional(profesional: string, dia: number): Array<{ inicio: string, fin: string }> {
  if (profesional === 'Francisco Chibilisco') {
    const horarios: Array<{ inicio: string, fin: string }> = [];
    if (dia >= 1 && dia <= 5) {
      horarios.push({ inicio: '11:00', fin: '13:00' });
    }
    if (dia === 4 || dia === 5) {
      horarios.push({ inicio: '15:00', fin: '20:00' });
    }
    if (dia === 6) {
      horarios.push({ inicio: '09:00', fin: '13:00' });
    }
    return horarios;
  }
  if (profesional === 'Javier Martoni') {
    if (dia >= 1 && dia <= 5) {
      return [{ inicio: '15:30', fin: '20:00' }];
    }
    return [];
  }
  return [];
}

function esDiaLaborable(fechaStr: string, profesional?: string): boolean {
  if (!profesional) return true;
  const dia = new Date(fechaStr + 'T12:00:00').getDay();
  return getHorarioProfesional(profesional, dia).length > 0;
}

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

function proximosDiasLaborables(cantidad: number, profesional?: string): { fecha: string; label: string }[] {
  const dias: { fecha: string; label: string }[] = [];
  const today = getToday();
  let offset = 0;

  while (dias.length < cantidad && offset < 30) {
    const candidate = addDays(today, offset);
    const day = candidate.getDay();
    const works = profesional ? (getHorarioProfesional(profesional, day) !== null) : (day >= 1 && day <= 6);
    
    if (works) {
      let label: string;
      if (offset === 0) {
        label = 'Hoy';
      } else if (offset === 1) {
        label = 'Mañana';
      } else {
        const weekday = candidate.toLocaleDateString('es-ES', { weekday: 'short' });
        const d = candidate.getDate();
        const month = candidate.toLocaleDateString('es-ES', { month: 'short' });
        label = `${weekday.charAt(0).toUpperCase() + weekday.slice(1)} ${d} ${month.charAt(0).toUpperCase() + month.slice(1)}`;
      }
      dias.push({ fecha: toDateStr(candidate), label });
    }
    offset++;
  }
  return dias;
}

function buildFechasKeyboard(profesional?: string) {
  const dias = proximosDiasLaborables(8, profesional);
  const keyboard = [];
  for (let i = 0; i < dias.length; i += 2) {
    keyboard.push(
      dias.slice(i, i + 2).map(d => ({
        text: d.label,
        callback_data: `fecha:${d.fecha}`
      }))
    );
  }
  keyboard.push([{ text: '🏠 Menú principal', callback_data: 'menu' }]);
  return keyboard;
}

function buildFechasView(servicio?: string, profesional?: string) {
  return {
    text: servicio
      ? `📅 *${servicio}*\n\n¿Qué día preferís?`
      : '📅 ¿Qué día te gustaría?',
    keyboard: buildFechasKeyboard(profesional)
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

// Eliminado esDiaLaborable antiguo

// Función para generar ID único
function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substr(2);
}

function reservaKey(profesional: string, fechaStr: string, horaStr: string): string {
  return `reserva:${profesional}:${fechaStr}:${horaStr}`;
}

// Helper: convertir hora "HH:MM" a minutos desde medianoche
function horaAMinutos(horaStr: string): number {
  const [h, m] = horaStr.split(':').map(Number);
  return h * 60 + m;
}

// Helper: chequear si un intervalo [start, end) se solapa con alguna reserva existente
async function haySolapamiento(profesional: string, fechaStr: string, startMinutos: number, endMinutos: number): Promise<boolean> {
  const servicio = getServicio;
  let reservasDelDia: Reservation[] = [];
  
  if (kv) {
    // Obtener todas las reservas del día y profesional
    const keys = await kv.keys(`reserva:${profesional}:${fechaStr}:*`);
    for (const key of keys) {
      const data = await kv.get(key);
      if (data) {
        const reserva = typeof data === 'string' ? JSON.parse(data) : data;
        reservasDelDia.push(reserva);
      }
    }
  } else {
    const localReservations = getLocalReservations();
    reservasDelDia = localReservations.filter(r => r.profesional === profesional && r.fecha === fechaStr);
  }
  
  for (const reserva of reservasDelDia) {
    const reservaStart = horaAMinutos(reserva.hora);
    const reservaServicio = getServicio(reserva.servicio);
    const reservaDuracion = reservaServicio ? reservaServicio.duracionMinutos : 60;
    const reservaEnd = reservaStart + reservaDuracion;
    
    // Chequear solapamiento: [startMinutos, endMinutos) vs [reservaStart, reservaEnd)
    if (!(endMinutos <= reservaStart || startMinutos >= reservaEnd)) {
      return true;
    }
  }
  
  return false;
}

async function obtenerHorariosLibres(fechaStr: string, profesional: string, servicioNombre: string): Promise<string[]> {
  const libres: string[] = [];
  const dia = new Date(fechaStr + 'T12:00:00').getDay();
  const horarios = getHorarioProfesional(profesional, dia);
  if (horarios.length === 0) return libres;
  
  const servicio = getServicio(servicioNombre);
  if (!servicio) return libres;
  
  for (const horario of horarios) {
    const [hIni, mIni] = horario.inicio.split(':').map(Number);
    const [hFin, mFin] = horario.fin.split(':').map(Number);
    let minutosActuales = hIni * 60 + mIni;
    const minutosFin = hFin * 60 + mFin;
    
    while (minutosActuales + servicio.duracionMinutos <= minutosFin) {
      const hStr = Math.floor(minutosActuales / 60).toString().padStart(2, '0');
      const mStr = (minutosActuales % 60).toString().padStart(2, '0');
      const horaStr = `${hStr}:${mStr}`;
      
      const slotStart = minutosActuales;
      const slotEnd = minutosActuales + servicio.duracionMinutos;
      const solapado = await haySolapamiento(profesional, fechaStr, slotStart, slotEnd);
      
      if (!solapado) {
        libres.push(horaStr);
      }
      minutosActuales += servicio.duracionMinutos;
    }
  }
  
  return libres;
}

async function buildHorariosView(fechaStr: string, servicio: string, profesional: string) {
  const horariosLibres = await obtenerHorariosLibres(fechaStr, profesional, servicio);

  if (horariosLibres.length === 0) {
    const otras = SERVICIOS.filter(s => s.nombre !== servicio);
    return {
      text:
        `😕 No hay turnos disponibles para *${servicio}* el ${formatDate(fechaStr)} con ${profesional}.\n\n` +
        `Podés probar con otra fecha o volver al menú:`,
      keyboard: [
        [{ text: '📅 Otra fecha', callback_data: 'cambiar_fecha' }],
        [{ text: '🏠 Menú principal', callback_data: 'menu' }]
      ]
    };
  }

  // Botones de horario en filas de 3
  const keyboard: any[] = [];
  for (let i = 0; i < horariosLibres.length; i += 3) {
    keyboard.push(
      horariosLibres.slice(i, i + 3).map(h => ({ text: `🕐 ${h}`, callback_data: `hora:${h}` }))
    );
  }
  // Botones de navegación al final
  keyboard.push([
    { text: '📅 Cambiar fecha', callback_data: 'cambiar_fecha' },
    { text: '🏠 Menú', callback_data: 'menu' }
  ]);

  return {
    text: `🗓 *${servicio}*\n📅 ${formatDate(fechaStr)}\n\n⏰ Elegí un horario:`,
    keyboard
  };
}

// ── Vista de confirmación ────────────────────────────────────────────────────
function buildConfirmacionView(estado: ConversationState) {
  const serv = getServicio(estado.servicio || '');
  return {
    text:
      `✅ *Confirmá tu turno*\n\n` +
      `👨‍⚕️ *Profesional:* ${estado.profesional}\n` +
      `🩺 *Servicio:* ${estado.servicio} (${serv ? '$'+serv.precio : ''})\n` +
      `👤 *Nombre:* ${estado.nombre}\n` +
      `📅 *Fecha:* ${formatDate(estado.fecha!)}\n` +
      `🕐 *Hora:* ${estado.hora}\n\n` +
      `*⚠️ Importante:* La atención es particular (no se recibe obra social).\n\n` +
      `¿Confirmás la reserva?`,
    keyboard: [
      [
        { text: '✅ Confirmar', callback_data: 'confirmar_reserva' },
        { text: '❌ Cancelar', callback_data: 'cambiar_fecha' }
      ],
      [{ text: '🏠 Menú principal', callback_data: 'menu' }]
    ]
  };
}
// ─────────────────────────────────────────────────────────────────────────────

async function verificarDisponibilidad(profesional: string, servicio: string, fechaStr: string, horaStr: string) {
  try {
    const fecha = new Date(fechaStr + 'T12:00:00');
    const dia = fecha.getDay();

    if (getHorarioProfesional(profesional, dia).length === 0) {
      return { disponible: false, mensaje: 'El profesional no atiende ese día.' };
    }

    const servicioData = getServicio(servicio);
    if (!servicioData) return { disponible: false, mensaje: 'Servicio no encontrado.' };

    const startMinutos = horaAMinutos(horaStr);
    const endMinutos = startMinutos + servicioData.duracionMinutos;
    const solapado = await haySolapamiento(profesional, fechaStr, startMinutos, endMinutos);
    if (solapado) {
      return {
        disponible: false,
        mensaje: `Ese horario ya está reservado. Podés elegir otro horario.`
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
    // Validar que el chatId coincida
    if (datos.chatId !== chatId) {
      console.warn(`[SEGURIDAD] chatId mismatch: ${chatId} vs ${datos.chatId}`);
      return null;
    }

    const id = generateId();
    const reserva: Reservation = { ...datos, id };
    const key = reservaKey(datos.profesional, datos.fecha, datos.hora);
    const idKey = `reserva:id:${id}`;

    if (kv) {
      const existente = await kv.get(key);
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
      const localReservations = getLocalReservations();
      const existente = localReservations.find(
        r => r.profesional === datos.profesional && r.fecha === datos.fecha && r.hora === datos.hora
      );
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
      const idKey = `reserva:id:${reservaId}`;
      const reservaData = await kv.get(idKey);
      if (!reservaData) return false;

      const reserva = typeof reservaData === 'string' ? JSON.parse(reservaData) : reservaData;

      // Verificar ownership
      if (reserva.chatId !== chatId) {
        console.warn(`[SEGURIDAD] Intento de eliminar reserva ajena: chatId ${chatId} vs ${reserva.chatId}`);
        return false;
      }

      await kv.del(reservaKey(reserva.profesional, reserva.fecha, reserva.hora));
      await kv.del(idKey);

      const userKey = `user:${chatId}:reservas`;
      const userReservas = await kv.get(userKey) || [];
      let reservasArray = Array.isArray(userReservas) ? userReservas : JSON.parse(userReservas as string);
      reservasArray = reservasArray.filter((r: Reservation) => r.id !== reservaId);
      await kv.set(userKey, JSON.stringify(reservasArray));
    } else {
      const localReservations = getLocalReservations();
      const index = localReservations.findIndex(r => r.id === reservaId && r.chatId === chatId);
      if (index !== -1) {
        localReservations.splice(index, 1);
      } else {
        return false;
      }
    }

    return true;
  } catch (error) {
    console.error('Error al eliminar reserva:', error);
    return false;
  }
}

// Set en memoria para deduplicar updates en entorno local
const processedUpdates = new Set<number>();

const MAX_RESERVACIONES_POR_USUARIO = 2;

async function checkReservationLimit(chatId: number): Promise<boolean> {
  let count = 0;
  if (kv) {
    const userReservasKey = `user:${chatId}:reservas`;
    const userReservas = await kv.get(userReservasKey) || [];
    const arr = Array.isArray(userReservas) ? userReservas : JSON.parse(userReservas as string);
    count = arr.length;
  } else {
    const localReservations = getLocalReservations();
    count = localReservations.filter(r => r.chatId === chatId).length;
  }
  return count >= MAX_RESERVACIONES_POR_USUARIO;
}

export async function POST(request: NextRequest) {
  console.log('=== NUEVA SOLICITUD ===');

  try {
    const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

    console.log('TELEGRAM_TOKEN presente:', !!TELEGRAM_TOKEN);
    console.log('KV configurado:', !!(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN));

    const update = await request.json();
    console.log('Update completo:', JSON.stringify(update, null, 2));

    // ── Deduplicación por update_id ──────────────────────────────────────
    const updateId: number | undefined = update?.update_id;
    if (updateId !== undefined) {
      const dedupKey = `processed:update:${updateId}`;
      if (kv) {
        const alreadyProcessed = await kv.get(dedupKey);
        if (alreadyProcessed) {
          console.log(`[DEDUP] Update ${updateId} ya procesado, ignorando.`);
          return NextResponse.json({ status: 'ok' });
        }
        await kv.set(dedupKey, '1', { ex: 600 });
      } else {
        if (processedUpdates.has(updateId)) {
          console.log(`[DEDUP LOCAL] Update ${updateId} ya procesado, ignorando.`);
          return NextResponse.json({ status: 'ok' });
        }
        processedUpdates.add(updateId);
        if (processedUpdates.size > 1000) {
          const first = processedUpdates.values().next().value;
          if (first !== undefined) processedUpdates.delete(first);
        }
      }
    }
    // ────────────────────────────────────────────────────────────────────

    // Obtener chatId para rate limit (tanto mensajes como callbacks)
    const chatIdForRateLimit: number | undefined =
      update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id;

    if (chatIdForRateLimit !== undefined) {
      const isRateLimited = await checkUserRateLimit(chatIdForRateLimit);
      if (isRateLimited) {
        console.log(`[RATE LIMIT] chatId ${chatIdForRateLimit} superó el límite de mensajes.`);
        // Responder al callback si lo hay para quitar el spinner de Telegram
        if (update.callback_query) {
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/answerCallbackQuery`, {
            callback_query_id: update.callback_query.id,
            text: '⚠️ Demasiadas solicitudes. Esperá un momento.',
            show_alert: false
          });
        } else {
          await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
            chat_id: chatIdForRateLimit,
            text: '⚠️ Estás enviando demasiados mensajes. Por favor esperá un momento antes de continuar.'
          });
        }
        return NextResponse.json({ status: 'ok' });
      }
    }

    // ── Helper compartido para estado ────────────────────────────────────
    function makeStateHelpers(chatId: number) {
      const estadoKey = `conv:${chatId}`;

      const getState = async (): Promise<ConversationState> => {
        if (kv) {
          const kvEstado = await kv.get(estadoKey);
          if (!kvEstado) return { paso: null };
          return typeof kvEstado === 'string' ? JSON.parse(kvEstado) : kvEstado;
        }
        return localStorage.get(estadoKey) || { paso: null };
      };

      const saveState = async (newState: ConversationState) => {
        if (kv) {
          await kv.set(estadoKey, JSON.stringify(newState));
        } else {
          localStorage.set(estadoKey, newState);
        }
      };

      const clearState = async () => {
        if (kv) {
          await kv.del(estadoKey);
        } else {
          localStorage.delete(estadoKey);
        }
      };

      return { getState, saveState, clearState };
    }
    // ────────────────────────────────────────────────────────────────────

    // Manejar callback queries (presionar botones)
    if (update.callback_query) {
      const callbackQuery = update.callback_query;
      const chatId = callbackQuery.message.chat.id;
      const data = callbackQuery.data;

      const { getState, saveState, clearState } = makeStateHelpers(chatId);
      let estado = await getState();

      // Helper para enviar mensajes con botones (con parse_mode Markdown)
      const sendWithKeyboard = async (t: string, keyboard: any = null) => {
        console.log('Enviando mensaje a Telegram:', t.substring(0, 100));
        try {
          const payload: any = {
            chat_id: chatId,
            text: t,
            parse_mode: 'Markdown'
          };
          if (keyboard) {
            payload.reply_markup = { inline_keyboard: keyboard };
          }
          const response = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, payload);
          console.log('✅ Mensaje enviado! Status:', response.status);
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

      // ── Manejar callbacks ────────────────────────────────────────────
      if (data === 'menu') {
        await clearState();
        await sendWithKeyboard('Hola 👋 ¿Qué necesitás?\n*(Atención particular, sin obra social)*', [
          [{ text: '📋 Ver profesionales', callback_data: 'profesionales' }],
          [{ text: '📋 Ver servicios', callback_data: 'servicios' }],
          [{ text: '📅 Reservar turno', callback_data: 'reservar' }],
          [{ text: '📋 Mis reservas', callback_data: 'misreservas' }]
        ]);

      } else if (data === 'profesionales') {
        await sendWithKeyboard(
          '👨‍⚕️ *Nuestros profesionales:*\n\n*Francisco Chibilisco*:\n- Lunes a viernes: 11 a 13 hs\n- Jueves y viernes: también 15 a 20 hs\n- Sábados: 9 a 13 hs\n\n*Javier Martoni*:\n- Lunes a viernes: 15:30 a 20 hs\n\n*(Atención particular, sin obra social)*',
          PROFESIONALES.map(p => [{ text: p, callback_data: `profesional:${p}` }])
        );
      } else if (data === 'servicios') {
        await sendWithKeyboard(
          '🩺 *Servicios disponibles:*\n\n*(Atención particular, sin obra social)*',
          SERVICIOS.map(s => [{ text: `${s.nombre} ($${s.precio})`, callback_data: 'noop' }])
        );

      } else if (data === 'reservar') {
        const limitReached = await checkReservationLimit(chatId);
        if (limitReached) {
          await sendWithKeyboard(
            '⚠️ *Límite de reservas alcanzado*\n\nYa tenés el máximo de turnos activos permitidos. Para reservar uno nuevo, primero tenés que cancelar alguno desde tus reservas.',
            [[{ text: '📋 Mis reservas', callback_data: 'misreservas' }], [{ text: '🏠 Menú', callback_data: 'menu' }]]
          );
        } else {
          await saveState({ paso: 'profesional' });
          await sendWithKeyboard(
            '¿Con qué profesional te querés atender?',
            PROFESIONALES.map(p => [{ text: p, callback_data: `profesional:${p}` }])
          );
        }

      } else if (data === 'misreservas') {
        let reservasArray: Reservation[] = [];

        if (kv) {
          const userReservasKey = `user:${chatId}:reservas`;
          const userReservas = await kv.get(userReservasKey) || [];
          let rawArray = Array.isArray(userReservas) ? userReservas : JSON.parse(userReservas as string);
          
          // Self-healing: verificar que las reservas realmente existan
          const validReservations = [];
          let changed = false;
          for (const r of rawArray) {
            const exists = await kv.get(`reserva:id:${r.id}`);
            if (exists) {
              validReservations.push(r);
            } else {
              changed = true; // Se encontró una reserva huérfana
            }
          }
          
          if (changed) {
            await kv.set(userReservasKey, JSON.stringify(validReservations));
          }
          reservasArray = validReservations;
        } else {
          const localReservations = getLocalReservations();
          reservasArray = localReservations.filter(r => r.chatId === chatId);
        }

        if (reservasArray.length === 0) {
          await sendWithKeyboard(
            'Todavía no tenés reservas. ¿Querés hacer una?',
            [
              [{ text: '✅ Sí, reservar', callback_data: 'reservar' }],
              [{ text: '🏠 Menú', callback_data: 'menu' }]
            ]
          );
        } else {
          const keyboard = reservasArray.map((r: Reservation) => [
            { text: `${r.servicio} con ${r.profesional} — ${formatDate(r.fecha)} ${r.hora}`, callback_data: 'noop' },
            { text: '❌ Eliminar', callback_data: `eliminar:${r.id}` }
          ]);
          keyboard.push([{ text: '🏠 Menú', callback_data: 'menu' }]);
          await sendWithKeyboard('📋 *Tus reservas:*', keyboard);
        }

      } else if (data.startsWith('eliminar:')) {
        const reservaId = data.replace('eliminar:', '');
        const eliminado = await eliminarReserva(chatId, reservaId);

        if (eliminado) {
          await sendWithKeyboard(
            '✅ Reserva eliminada correctamente.',
            [
              [{ text: '📋 Mis reservas', callback_data: 'misreservas' }],
              [{ text: '🏠 Menú', callback_data: 'menu' }]
            ]
          );
        } else {
          await sendWithKeyboard(
            'No se pudo eliminar la reserva.',
            [[{ text: '🏠 Menú', callback_data: 'menu' }]]
          );
        }

      } else if (data.startsWith('profesional:')) {
        const profSeleccionado = data.replace('profesional:', '');
        await saveState({ paso: 'servicio', profesional: profSeleccionado });
        await sendWithKeyboard(
          `*${profSeleccionado}* ✔️\n\n¿Qué servicio querés reservar?`,
          SERVICIOS.map(s => [{ text: s.nombre, callback_data: `servicio:${s.nombre}` }])
        );
      } else if (data.startsWith('servicio:')) {
        const servicioSeleccionado = data.replace('servicio:', '');
        if (estado.nombre && estado.fecha && estado.profesional) {
          await saveState({ ...estado, paso: 'hora', servicio: servicioSeleccionado });
          const view = await buildHorariosView(estado.fecha, servicioSeleccionado, estado.profesional);
          await sendWithKeyboard(view.text, view.keyboard);
        } else {
          await saveState({ ...estado, paso: 'nombre', servicio: servicioSeleccionado });
          await sendWithKeyboard(`*${servicioSeleccionado}* ✔️\n\n¿Cuál es tu nombre?`);
        }

      } else if (data === 'cambiar_fecha') {
        await saveState({ paso: 'fecha', servicio: estado.servicio, nombre: estado.nombre, profesional: estado.profesional });
        const view = buildFechasView(estado.servicio, estado.profesional);
        await sendWithKeyboard(view.text, view.keyboard);

      } else if (data.startsWith('fecha:')) {
        const fechaSeleccionada = data.replace('fecha:', '');
        if (estado.servicio && estado.profesional) {
          await saveState({ ...estado, paso: 'hora', fecha: fechaSeleccionada });
          const view = await buildHorariosView(fechaSeleccionada, estado.servicio, estado.profesional);
          await sendWithKeyboard(view.text, view.keyboard);
        }

      } else if (data === 'refresh_horarios') {
        if (estado.fecha && estado.servicio && estado.profesional) {
          const view = await buildHorariosView(estado.fecha, estado.servicio, estado.profesional);
          await sendWithKeyboard(view.text, view.keyboard);
        }

      } else if (data.startsWith('hora:')) {
        const horaSeleccionada = data.replace('hora:', '');

        // Verificar disponibilidad antes de mostrar confirmación
        const disponibilidad = await verificarDisponibilidad(estado.profesional!, estado.servicio!, estado.fecha!, horaSeleccionada);

        if (disponibilidad.disponible) {
          // Guardar la hora en estado y pasar a confirmación
          await saveState({ ...estado, paso: 'confirmar', hora: horaSeleccionada });
          const view = buildConfirmacionView({ ...estado, hora: horaSeleccionada });
          await sendWithKeyboard(view.text, view.keyboard);
        } else {
          // Slot ocupado: mostrar horarios actualizados
          const viewActualizada = await buildHorariosView(estado.fecha!, estado.servicio!, estado.profesional!);
          await sendWithKeyboard(
            `⚠️ ${disponibilidad.mensaje || 'Ese horario no está disponible.'}\n\nElegí otro turno:`,
            viewActualizada.keyboard
          );
        }

      } else if (data === 'confirmar_reserva') {
        // Verificar disponibilidad de nuevo (pudo ocuparse mientras confirmaba)
        const disponibilidad = await verificarDisponibilidad(estado.profesional!, estado.servicio!, estado.fecha!, estado.hora!);

        if (disponibilidad.disponible) {
          const datosReserva = {
            profesional: estado.profesional!,
            servicio: estado.servicio!,
            nombre: estado.nombre!,
            fecha: estado.fecha!,
            hora: estado.hora!,
            chatId: chatId
          };

          const reserva = await guardarReserva(chatId, datosReserva);

          if (reserva) {
            await clearState();
            await sendWithKeyboard(
              `🎉 *¡Reserva confirmada!*\n\n` +
              `👨‍⚕️ ${reserva.profesional}\n` +
              `✨ *${reserva.servicio}*\n` +
              `📅 ${formatDate(reserva.fecha)}\n` +
              `🕐 ${reserva.hora}\n` +
              `👤 ${reserva.nombre}\n\n` +
              `¡Nos vemos! 😊`,
              [
                [{ text: '📋 Mis reservas', callback_data: 'misreservas' }],
                [{ text: '🏠 Menú', callback_data: 'menu' }]
              ]
            );
          } else {
            // El slot fue tomado justo antes: mostrar horarios actualizados
            const viewActualizada = await buildHorariosView(estado.fecha!, estado.servicio!, estado.profesional!);
            await sendWithKeyboard(
              `⚠️ Ese horario acaba de ser reservado.\n\nElegí otro turno para *${estado.servicio}*:`,
              viewActualizada.keyboard
            );
          }
        } else {
          const viewActualizada = await buildHorariosView(estado.fecha!, estado.servicio!, estado.profesional!);
          await sendWithKeyboard(
            `⚠️ ${disponibilidad.mensaje || 'Ese horario ya no está disponible.'}\n\nElegí otro turno:`,
            viewActualizada.keyboard
          );
        }

      } else if (data === 'noop') {
        // No hacer nada
      }

      return NextResponse.json({ status: 'ok' });
    }

    // ── Mensajes de texto ────────────────────────────────────────────────
    if (update && update.message) {
      const msg = update.message;
      const text = msg.text || '';
      const chatId = msg.chat.id;

      console.log('Mensaje de texto:', text);
      console.log('Chat ID:', chatId);

      const { getState, saveState, clearState } = makeStateHelpers(chatId);
      let estado = await getState();

      // Helper para enviar mensajes con botones (con parse_mode Markdown)
      const sendWithKeyboard = async (t: string, keyboard: any = null) => {
        console.log('Enviando mensaje a Telegram:', t.substring(0, 100));
        try {
          const payload: any = {
            chat_id: chatId,
            text: t,
            parse_mode: 'Markdown'
          };
          if (keyboard) {
            payload.reply_markup = { inline_keyboard: keyboard };
          }
          const response = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, payload);
          console.log('✅ Mensaje enviado! Status:', response.status);
        } catch (e: any) {
          console.error('❌ Error al enviar mensaje:', e.message);
          if (e.response) {
            console.error('Response data:', JSON.stringify(e.response.data, null, 2));
          }
        }
      };

      const showMainMenu = async () => {
        await sendWithKeyboard('Hola 👋 ¿Qué necesitás?\n*(Atención particular, sin obra social)*', [
          [{ text: '📋 Ver profesionales', callback_data: 'profesionales' }],
          [{ text: '📋 Ver servicios', callback_data: 'servicios' }],
          [{ text: '📅 Reservar turno', callback_data: 'reservar' }],
          [{ text: '📋 Mis reservas', callback_data: 'misreservas' }]
        ]);
      };

      const showServices = async () => {
        await sendWithKeyboard(
          '🩺 *Servicios disponibles:*\n\n*(Atención particular, sin obra social)*',
          SERVICIOS.map(s => [{ text: `${s.nombre} ($${s.precio})`, callback_data: 'noop' }])
        );
      };

      const showHorarios = async (fechaStr: string, servicio: string, profesional: string) => {
        await saveState({ ...estado, paso: 'hora', servicio, nombre: estado.nombre, fecha: fechaStr, profesional });
        const view = await buildHorariosView(fechaStr, servicio, profesional);
        await sendWithKeyboard(view.text, view.keyboard);
      };

      const normalizedText = text.toLowerCase().trim();

      if (['/start', 'start', 'hola', 'hello', 'buenos días', 'buenas tardes', 'buenas noches', 'hey'].includes(normalizedText)) {
        // Limpiar estado completamente → usuario nuevo comienza desde cero
        await clearState();
        await showMainMenu();

      } else if (['/servicios', 'servicios', 'servicio', '/categorias', 'categorias', 'categoria', 'que servicios hay'].includes(normalizedText)) {
        await showServices();

      } else if (['/misreservas', 'mis reservas', 'misreservas', 'reservas', 'ver reservas', 'ver mis reservas'].includes(normalizedText)) {
        let reservasArray: Reservation[] = [];

        if (kv) {
          const userReservasKey = `user:${chatId}:reservas`;
          const userReservas = await kv.get(userReservasKey) || [];
          let rawArray = Array.isArray(userReservas) ? userReservas : JSON.parse(userReservas as string);
          
          // Self-healing: verificar que las reservas realmente existan
          const validReservations = [];
          let changed = false;
          for (const r of rawArray) {
            const exists = await kv.get(`reserva:id:${r.id}`);
            if (exists) {
              validReservations.push(r);
            } else {
              changed = true;
            }
          }
          
          if (changed) {
            await kv.set(userReservasKey, JSON.stringify(validReservations));
          }
          reservasArray = validReservations;
        } else {
          const localReservations = getLocalReservations();
          reservasArray = localReservations.filter(r => r.chatId === chatId);
        }

        if (reservasArray.length === 0) {
          await sendWithKeyboard(
            'Todavía no tenés reservas. ¿Querés hacer una?',
            [
              [{ text: '✅ Sí, reservar', callback_data: 'reservar' }],
              [{ text: '🏠 Menú', callback_data: 'menu' }]
            ]
          );
        } else {
          const keyboard = reservasArray.map((r: Reservation) => [
            { text: `${r.servicio} — ${formatDate(r.fecha)} ${r.hora}`, callback_data: 'noop' },
            { text: '❌ Eliminar', callback_data: `eliminar:${r.id}` }
          ]);
          keyboard.push([{ text: '🏠 Menú', callback_data: 'menu' }]);
          await sendWithKeyboard('📋 *Tus reservas:*', keyboard);
        }

      } else if (['/reservar', 'reservar', 'reservar turno', 'quiero reservar', 'agendar', 'quiero agendar', 'hacer una reserva'].includes(normalizedText)) {
        const limitReached = await checkReservationLimit(chatId);
        if (limitReached) {
          await sendWithKeyboard(
            '⚠️ *Límite de reservas alcanzado*\n\nYa tenés el máximo de turnos activos permitidos. Para reservar uno nuevo, primero tenés que cancelar alguno desde tus reservas.',
            [[{ text: '📋 Mis reservas', callback_data: 'misreservas' }], [{ text: '🏠 Menú', callback_data: 'menu' }]]
          );
        } else {
          await saveState({ paso: 'profesional' });
          await sendWithKeyboard(
            '¿Con qué profesional te querés atender?',
            PROFESIONALES.map(p => [{ text: p, callback_data: `profesional:${p}` }])
          );
        }

      } else if (estado && estado.paso) {
        console.log('Estado de conversación:', estado);

        if (estado.paso === 'profesional') {
          let profSeleccionado = null;
          const num = parseInt(text);
          if (!isNaN(num) && num >= 1 && num <= PROFESIONALES.length) {
            profSeleccionado = PROFESIONALES[num - 1];
          } else {
            profSeleccionado = PROFESIONALES.find(p => p.toLowerCase().includes(text.toLowerCase()));
          }
          if (profSeleccionado) {
            await saveState({ paso: 'servicio', profesional: profSeleccionado });
            await sendWithKeyboard(
              `*${profSeleccionado}* ✔️\n\n¿Qué servicio querés reservar?`,
              SERVICIOS.map(s => [{ text: s.nombre, callback_data: `servicio:${s.nombre}` }])
            );
          } else {
            await sendWithKeyboard('Elegí un profesional válido:', PROFESIONALES.map(p => [{ text: p, callback_data: `profesional:${p}` }]));
          }
        } else if (estado.paso === 'servicio') {
          let servicioSeleccionado = null;
          const num = parseInt(text);
          if (!isNaN(num) && num >= 1 && num <= SERVICIOS.length) {
            servicioSeleccionado = SERVICIOS[num - 1].nombre;
          } else {
            servicioSeleccionado = SERVICIOS.find(s => s.nombre.toLowerCase().includes(text.toLowerCase()))?.nombre;
          }

          if (servicioSeleccionado) {
            await saveState({ ...estado, paso: 'nombre', servicio: servicioSeleccionado });
            await sendWithKeyboard(`*${servicioSeleccionado}* ✔️\n\n¿Cuál es tu nombre?`);
          } else {
            await sendWithKeyboard(
              'No reconozco ese servicio. Por favor elegí uno:',
              SERVICIOS.map(s => [{ text: s.nombre, callback_data: `servicio:${s.nombre}` }])
            );
          }

        } else if (estado.paso === 'nombre') {
          await saveState({ ...estado, paso: 'fecha', nombre: text });
          const view = buildFechasView(estado.servicio, estado.profesional);
          await sendWithKeyboard(`Hola *${text}* 👋\n\n${view.text}`, view.keyboard);

        } else if (estado.paso === 'fecha') {
          const fechaParseada = parseFecha(text);
          if (fechaParseada && esDiaLaborable(fechaParseada, estado.profesional)) {
            await showHorarios(fechaParseada, estado.servicio!, estado.profesional!);
          } else if (fechaParseada && !esDiaLaborable(fechaParseada, estado.profesional)) {
            await sendWithKeyboard(
              '❌ El profesional no atiende ese día. Elegí otro:',
              buildFechasKeyboard(estado.profesional)
            );
          } else {
            const view = buildFechasView(estado.servicio, estado.profesional);
            await sendWithKeyboard('Elegí un día de la lista:', view.keyboard);
          }

        } else if (estado.paso === 'hora') {
          const horariosLibres = await obtenerHorariosLibres(estado.fecha!, estado.profesional!, estado.servicio!);
          let horaSeleccionada: string | null = null;

          const num = parseInt(text);
          if (!isNaN(num) && num >= 1 && num <= horariosLibres.length) {
            horaSeleccionada = horariosLibres[num - 1];
          } else {
            horaSeleccionada = horariosLibres.find(h =>
              h.includes(text) || text.includes(h)
            ) ?? null;
          }

          if (horaSeleccionada) {
            const disponibilidad = await verificarDisponibilidad(estado.profesional!, estado.servicio!, estado.fecha!, horaSeleccionada);

            if (disponibilidad.disponible) {
              // Pasar a confirmación
              await saveState({ ...estado, paso: 'confirmar', hora: horaSeleccionada });
              const view = buildConfirmacionView({ ...estado, hora: horaSeleccionada });
              await sendWithKeyboard(view.text, view.keyboard);
            } else {
              const viewActualizada = await buildHorariosView(estado.fecha!, estado.servicio!, estado.profesional!);
              await sendWithKeyboard(
                `⚠️ ${disponibilidad.mensaje || 'Ese horario no está disponible.'}\n\nElegí otro turno:`,
                viewActualizada.keyboard
              );
            }
          } else {
            await showHorarios(estado.fecha!, estado.servicio!, estado.profesional!);
          }

        } else if (estado.paso === 'confirmar') {
          // El usuario escribió algo durante la confirmación → recordarle que use los botones
          const view = buildConfirmacionView(estado);
          await sendWithKeyboard('Por favor usá los botones para confirmar o cancelar:\n\n' + view.text, view.keyboard);
        }

      } else {
        await showMainMenu();
      }
    }

    console.log('=== FINALIZANDO ===');
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
