import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import { createClient } from '@vercel/kv';
import { getLocalReservations, addLocalReservation } from '../admin/reservations/route';
import {
  BotIntent,
  isValidFlowInput,
  matchesLoosely,
  normalizeHumanText,
  parseInfoQuery,
  parseLocalIntent,
} from '@/lib/bot-intent';
import { appendChatMessage, formatChatHistoryForPrompt, getChatHistory } from '@/lib/chat-memory';
import {
  crearEventoCalendar,
  actualizarEventoCalendar,
  eliminarEventoCalendar,
  verificarDisponibilidadCalendar,
} from '@/lib/googleCalendar';
import { addDays, getToday, parseFecha, toDateStr } from '@/lib/parse-fecha';
import type { ConversationState, Reservation } from '@/lib/types';
import { getUserProfile, saveUserProfile } from '@/lib/user-profile';

interface AIResponse {
  responseText: string;
  intent: BotIntent;
  shouldContinueWithFlow: boolean;
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

// Interfaces for config
interface TimeSlot {
  inicio: string;
  fin: string;
}

interface ProfessionalSchedule {
  [day: number]: TimeSlot[];
}

interface Config {
  profesionales: {
    [name: string]: ProfessionalSchedule;
  };
  feriados: string[];
  servicios: Array<{ nombre: string; duracionMinutos: number; precio: number }>;
}

// Default config
const DEFAULT_CONFIG: Config = {
  profesionales: {
    'Francisco Chibilisco': {
      1: [{ inicio: '11:00', fin: '13:00' }],
      2: [{ inicio: '11:00', fin: '13:00' }],
      3: [{ inicio: '11:00', fin: '13:00' }],
      4: [{ inicio: '11:00', fin: '13:00' }, { inicio: '15:00', fin: '20:00' }],
      5: [{ inicio: '11:00', fin: '13:00' }, { inicio: '15:00', fin: '20:00' }],
      6: [{ inicio: '09:00', fin: '13:00' }],
    },
    'Javier Martoni': {
      1: [{ inicio: '15:30', fin: '20:00' }],
      2: [{ inicio: '15:30', fin: '20:00' }],
      3: [{ inicio: '15:30', fin: '20:00' }],
      4: [{ inicio: '15:30', fin: '20:00' }],
      5: [{ inicio: '15:30', fin: '20:00' }],
    }
  },
  feriados: [],
  servicios: [
    { nombre: 'Sesión de Quiropraxia', duracionMinutos: 25, precio: 30000 },
    { nombre: 'Masaje Relajante', duracionMinutos: 45, precio: 30000 },
    { nombre: 'Sesión Premium', duracionMinutos: 60, precio: 55000 }
  ]
};

const KV_CONFIG_KEY = 'app:config';

async function getConfig(): Promise<Config> {
  let config: Config;
  if (kv) {
    const stored = await kv.get(KV_CONFIG_KEY);
    config = stored ? (typeof stored === 'string' ? JSON.parse(stored) : stored) : DEFAULT_CONFIG;
  } else {
    // Local config for dev
    const localConfig = (global as any)._localAppConfig;
    config = localConfig || DEFAULT_CONFIG;
  }

  // Merge with default
  config = {
    ...DEFAULT_CONFIG,
    ...config,
    profesionales: {
      ...DEFAULT_CONFIG.profesionales,
      ...config.profesionales
    },
    servicios: config.servicios && config.servicios.length > 0 ? config.servicios : DEFAULT_CONFIG.servicios
  };

  return config;
}

async function getProfesionales() {
  const config = await getConfig();
  return Object.keys(config.profesionales);
}

async function getServiciosList() {
  const config = await getConfig();
  return config.servicios;
}

async function getServicio(nombre: string) {
  const servicios = await getServiciosList();
  return servicios.find(s => s.nombre.toLowerCase() === nombre.toLowerCase());
}

async function getHorarioProfesional(profesional: string, dia: number): Promise<Array<{ inicio: string, fin: string }>> {
  const config = await getConfig();
  const profSchedule = config.profesionales[profesional];
  return profSchedule?.[dia] || [];
}

async function isFeriado(fechaStr: string): Promise<boolean> {
  const config = await getConfig();
  return config.feriados.includes(fechaStr);
}

async function esDiaLaborable(fechaStr: string, profesional?: string): Promise<boolean> {
  const esFeriadoFlag = await isFeriado(fechaStr);
  if (esFeriadoFlag) return false;
  
  if (!profesional) {
    const dia = new Date(fechaStr + 'T12:00:00').getDay();
    return dia >= 1 && dia <= 6;
  }
  
  const dia = new Date(fechaStr + 'T12:00:00').getDay();
  const horarios = await getHorarioProfesional(profesional, dia);
  return horarios.length > 0;
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

async function proximosDiasLaborables(cantidad: number, profesional?: string): Promise<{ fecha: string; label: string }[]> {
  const dias: { fecha: string; label: string }[] = [];
  const today = getToday();
  let offset = 0;

  while (dias.length < cantidad && offset < 30) {
    const candidate = addDays(today, offset);
    const candidateFechaStr = toDateStr(candidate);
    const day = candidate.getDay();
    let works: boolean;
    if (profesional) {
      const esFeriadoFlag = await isFeriado(candidateFechaStr);
      if (esFeriadoFlag) {
        works = false;
      } else {
        const horarios = await getHorarioProfesional(profesional, day);
        works = horarios.length > 0;
      }
    } else {
      const esFeriadoFlag = await isFeriado(candidateFechaStr);
      works = !esFeriadoFlag && (day >= 1 && day <= 6);
    }
    
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
      dias.push({ fecha: candidateFechaStr, label });
    }
    offset++;
  }
  return dias;
}

async function buildFechasKeyboard(profesional?: string) {
  const dias = await proximosDiasLaborables(8, profesional);
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

async function buildFechasView(servicio?: string, profesional?: string) {
  return {
    text: servicio
      ? `📅 *${servicio}*\n\n¿Qué día preferís?`
      : '📅 ¿Qué día te gustaría?',
    keyboard: await buildFechasKeyboard(profesional)
  };
}

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
const STATE_TTL_MS = 30 * 60 * 1000;

async function haySolapamiento(
  profesional: string,
  fechaStr: string,
  startMinutos: number,
  endMinutos: number,
  excludeReservaId?: string
): Promise<boolean> {
  let reservasDelDia: Reservation[] = [];

  if (kv) {
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
    if (excludeReservaId && reserva.id === excludeReservaId) continue;

    const reservaStart = horaAMinutos(reserva.hora);
    const reservaServicio = await getServicio(reserva.servicio);
    const reservaDuracion = reservaServicio ? reservaServicio.duracionMinutos : 60;
    const reservaEnd = reservaStart + reservaDuracion;

    if (!(endMinutos <= reservaStart || startMinutos >= reservaEnd)) {
      return true;
    }
  }

  return false;
}

async function obtenerHorariosLibres(
  fechaStr: string,
  profesional: string,
  servicioNombre: string,
  excludeReservaId?: string
): Promise<string[]> {
  const libres: string[] = [];
  const dia = new Date(fechaStr + 'T12:00:00').getDay();
  const horarios = await getHorarioProfesional(profesional, dia);
  if (horarios.length === 0) return libres;
  
  const servicio = await getServicio(servicioNombre);
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
      const solapado = await haySolapamiento(profesional, fechaStr, slotStart, slotEnd, excludeReservaId);
      
      if (!solapado) {
        libres.push(horaStr);
      }
      minutosActuales += servicio.duracionMinutos;
    }
  }
  
  return libres;
}

async function buildHorariosView(
  fechaStr: string,
  servicio: string,
  profesional: string,
  excludeReservaId?: string
) {
  const horariosLibres = await obtenerHorariosLibres(fechaStr, profesional, servicio, excludeReservaId);

  if (horariosLibres.length === 0) {
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
async function buildConfirmacionView(estado: ConversationState) {
  const serv = await getServicio(estado.servicio || '');
  const isReschedule = Boolean(estado.rescheduleId);

  return {
    text:
      `${isReschedule ? '🔄 *Confirmá el cambio de turno*' : '✅ *Confirmá tu turno*'}\n\n` +
      `👨‍⚕️ *Profesional:* ${estado.profesional}\n` +
      `🩺 *Servicio:* ${estado.servicio} (${serv ? '$'+serv.precio : ''})\n` +
      `👤 *Nombre:* ${estado.nombre}\n` +
      `📅 *Fecha:* ${formatDate(estado.fecha!)}\n` +
      `🕐 *Hora:* ${estado.hora}\n\n` +
      `*⚠️ Importante:* La atención es particular (no se recibe obra social).\n\n` +
      `${isReschedule ? '¿Confirmás el cambio?' : '¿Confirmás la reserva?'}`,
    keyboard: [
      [
        { text: '✅ Confirmar', callback_data: isReschedule ? 'confirmar_reprogramar' : 'confirmar_reserva' },
        { text: '❌ Cancelar', callback_data: isReschedule ? 'misreservas' : 'cambiar_fecha' }
      ],
      [{ text: '🏠 Menú principal', callback_data: 'menu' }]
    ]
  };
}
// ─────────────────────────────────────────────────────────────────────────────

async function verificarDisponibilidad(
  profesional: string,
  servicio: string,
  fechaStr: string,
  horaStr: string,
  options?: { excludeReservaId?: string; excludeEventId?: string }
) {
  try {
    const fecha = new Date(fechaStr + 'T12:00:00');
    const dia = fecha.getDay();

    const esFeriadoFlag = await isFeriado(fechaStr);
    if (esFeriadoFlag) {
      return { disponible: false, mensaje: 'Ese día es feriado.' };
    }

    const horarios = await getHorarioProfesional(profesional, dia);
    if (horarios.length === 0) {
      return { disponible: false, mensaje: 'El profesional no atiende ese día.' };
    }

    const servicioData = await getServicio(servicio);
    if (!servicioData) return { disponible: false, mensaje: 'Servicio no encontrado.' };

    const startMinutos = horaAMinutos(horaStr);
    const endMinutos = startMinutos + servicioData.duracionMinutos;
    const solapado = await haySolapamiento(
      profesional,
      fechaStr,
      startMinutos,
      endMinutos,
      options?.excludeReservaId
    );
    if (solapado) {
      return {
        disponible: false,
        mensaje: 'Ese horario ya está reservado. Podés elegir otro horario.'
      };
    }

    const calendarCheck = await verificarDisponibilidadCalendar(
      fechaStr,
      horaStr,
      servicioData.duracionMinutos,
      options?.excludeEventId
    );
    if (!calendarCheck.disponible) {
      return calendarCheck;
    }

    return { disponible: true };
  } catch (error) {
    console.error('Error al verificar disponibilidad:', error);
    return { disponible: false, mensaje: 'Error al verificar disponibilidad. Intenta más tarde.' };
  }
}

async function persistReservationRecord(reserva: Reservation) {
  const key = reservaKey(reserva.profesional, reserva.fecha, reserva.hora);
  const idKey = `reserva:id:${reserva.id}`;

  if (kv) {
    await kv.set(key, JSON.stringify(reserva), { ex: 86400 * 30 });
    await kv.set(idKey, JSON.stringify(reserva), { ex: 86400 * 30 });
  } else {
    const localReservations = getLocalReservations();
    const index = localReservations.findIndex(r => r.id === reserva.id);
    if (index >= 0) {
      localReservations[index] = reserva;
    } else {
      addLocalReservation(reserva);
    }
  }
}

async function getReservaById(chatId: number, reservaId: string): Promise<Reservation | null> {
  if (kv) {
    const reservaData = await kv.get(`reserva:id:${reservaId}`);
    if (!reservaData) return null;
    const reserva = typeof reservaData === 'string' ? JSON.parse(reservaData) : reservaData;
    return reserva.chatId === chatId ? reserva : null;
  }

  return getLocalReservations().find(r => r.id === reservaId && r.chatId === chatId) || null;
}

// Función para guardar reserva
async function guardarReserva(chatId: number, datos: Omit<Reservation, 'id'>): Promise<Reservation | null> {
  try {
    if (datos.chatId !== chatId) {
      console.warn(`[SEGURIDAD] chatId mismatch: ${chatId} vs ${datos.chatId}`);
      return null;
    }

    const id = generateId();
    const reserva: Reservation = {
      ...datos,
      id,
      reminder24hSent: false,
      reminder1hSent: false,
    };
    const key = reservaKey(datos.profesional, datos.fecha, datos.hora);

    if (kv) {
      const existente = await kv.get(key);
      if (existente) {
        console.log(`[DUPLICADO EVITADO] Ya existe reserva en ${key}`);
        return null;
      }
    } else {
      const localReservations = getLocalReservations();
      const existente = localReservations.find(
        r => r.profesional === datos.profesional && r.fecha === datos.fecha && r.hora === datos.hora
      );
      if (existente) {
        console.log(`[DUPLICADO EVITADO LOCAL] Ya existe reserva en ${datos.fecha} ${datos.hora}`);
        return null;
      }
    }

    const servicioData = await getServicio(datos.servicio);
    const calendarResult = await crearEventoCalendar(datos, servicioData?.duracionMinutos || 60);
    if (calendarResult.success && calendarResult.eventId) {
      reserva.calendarEventId = calendarResult.eventId;
    }

    await persistReservationRecord(reserva);

    if (kv) {
      const userKey = `user:${chatId}:reservas`;
      const userReservas = await kv.get(userKey) || [];
      const reservasArray = Array.isArray(userReservas) ? userReservas : JSON.parse(userReservas as string);
      reservasArray.push(reserva);
      await kv.set(userKey, JSON.stringify(reservasArray));
    }

    await saveUserProfile(chatId, datos.nombre, kv);
    return reserva;
  } catch (error) {
    console.error('Error al guardar reserva:', error);
    return null;
  }
}

async function reprogramarReserva(
  chatId: number,
  reservaId: string,
  nuevaFecha: string,
  nuevaHora: string
): Promise<Reservation | null> {
  try {
    const reserva = await getReservaById(chatId, reservaId);
    if (!reserva) return null;

    const disponibilidad = await verificarDisponibilidad(
      reserva.profesional,
      reserva.servicio,
      nuevaFecha,
      nuevaHora,
      {
        excludeReservaId: reserva.id,
        excludeEventId: reserva.calendarEventId,
      }
    );

    if (!disponibilidad.disponible) {
      return null;
    }

    if (kv) {
      await kv.del(reservaKey(reserva.profesional, reserva.fecha, reserva.hora));
    } else {
      const localReservations = getLocalReservations();
      const index = localReservations.findIndex(
        r => r.profesional === reserva.profesional && r.fecha === reserva.fecha && r.hora === reserva.hora
      );
      if (index >= 0) localReservations.splice(index, 1);
    }

    const updatedReservation: Reservation = {
      ...reserva,
      fecha: nuevaFecha,
      hora: nuevaHora,
      reminder24hSent: false,
      reminder1hSent: false,
    };

    const servicioData = await getServicio(reserva.servicio);
    if (reserva.calendarEventId) {
      const calendarUpdate = await actualizarEventoCalendar(
        reserva.calendarEventId,
        updatedReservation,
        servicioData?.duracionMinutos || 60
      );
      if (!calendarUpdate.success) {
        const calendarCreate = await crearEventoCalendar(updatedReservation, servicioData?.duracionMinutos || 60);
        if (calendarCreate.success && calendarCreate.eventId) {
          updatedReservation.calendarEventId = calendarCreate.eventId;
        }
      }
    } else {
      const calendarCreate = await crearEventoCalendar(updatedReservation, servicioData?.duracionMinutos || 60);
      if (calendarCreate.success && calendarCreate.eventId) {
        updatedReservation.calendarEventId = calendarCreate.eventId;
      }
    }

    await persistReservationRecord(updatedReservation);

    if (kv) {
      const userKey = `user:${chatId}:reservas`;
      const userReservas = await kv.get(userKey) || [];
      let reservasArray = Array.isArray(userReservas) ? userReservas : JSON.parse(userReservas as string);
      reservasArray = reservasArray.map((r: Reservation) => (r.id === reservaId ? updatedReservation : r));
      await kv.set(userKey, JSON.stringify(reservasArray));
    }

    return updatedReservation;
  } catch (error) {
    console.error('Error al reprogramar reserva:', error);
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

      if (reserva.chatId !== chatId) {
        console.warn(`[SEGURIDAD] Intento de eliminar reserva ajena: chatId ${chatId} vs ${reserva.chatId}`);
        return false;
      }

      await eliminarEventoCalendar(reserva.calendarEventId);

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

// Groq Integration
const ASSIST_KEYBOARD = [
  [{ text: '📅 Reservar turno', callback_data: 'reservar' }],
  [{ text: '📋 Ver servicios', callback_data: 'servicios' }, { text: '🏠 Menú', callback_data: 'menu' }]
];

async function getContextualKeyboard(estado: ConversationState, _chatId?: number): Promise<any[][]> {
  switch (estado.paso) {
    case 'profesional': {
      const profesionales = await getProfesionales();
      return [
        ...profesionales.map(p => [{ text: p, callback_data: `profesional:${p}` }]),
        [{ text: '🏠 Menú', callback_data: 'menu' }]
      ];
    }
    case 'servicio': {
      const servicios = await getServiciosList();
      return [
        ...servicios.map(s => [{ text: `${s.nombre} ($${s.precio.toLocaleString('es-AR')})`, callback_data: `servicio:${s.nombre}` }]),
        [{ text: '🏠 Menú', callback_data: 'menu' }]
      ];
    }
    case 'nombre':
      return [[{ text: '🏠 Menú', callback_data: 'menu' }]];
    case 'fecha':
      return await buildFechasKeyboard(estado.profesional);
    case 'hora': {
      if (estado.fecha && estado.servicio && estado.profesional) {
        const view = await buildHorariosView(estado.fecha, estado.servicio, estado.profesional, estado.rescheduleId);
        return view.keyboard;
      }
      return ASSIST_KEYBOARD;
    }
    case 'confirmar': {
      const isReschedule = Boolean(estado.rescheduleId);
      return [
        [
          { text: '✅ Confirmar', callback_data: isReschedule ? 'confirmar_reprogramar' : 'confirmar_reserva' },
          { text: '❌ Cancelar', callback_data: isReschedule ? 'misreservas' : 'cambiar_fecha' }
        ],
        [{ text: '🏠 Menú principal', callback_data: 'menu' }]
      ];
    }
    default:
      return ASSIST_KEYBOARD;
  }
}

const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

async function buildHorariosInfoMessage(): Promise<string> {
  const config = await getConfig();
  let message = '⏰ *Horarios de atención*\n\n*(Atención particular, sin obra social)*\n\n';

  for (const [profesional, schedule] of Object.entries(config.profesionales)) {
    message += `👨‍⚕️ *${profesional}*\n`;
    const days = Object.keys(schedule).map(Number).sort((a, b) => a - b);

    for (const day of days) {
      const slots = schedule[day];
      const slotText = slots.map(slot => `${slot.inicio} a ${slot.fin}`).join(' y ');
      message += `• ${DAY_NAMES[day]}: ${slotText}\n`;
    }

    message += '\n';
  }

  message += 'Si querés, puedo ayudarte a reservar un turno disponible.';
  return message;
}

async function buildPreciosInfoMessage(): Promise<string> {
  const servicios = await getServiciosList();
  let message = '💰 *Servicios y precios*\n\n*(Atención particular, sin obra social)*\n\n';

  for (const servicio of servicios) {
    message += `• *${servicio.nombre}*: $${servicio.precio.toLocaleString('es-AR')} (${servicio.duracionMinutos} min)\n`;
  }

  message += '\n¿Te gustaría reservar alguno?';
  return message;
}

async function buildClinicContextForAI(): Promise<string> {
  const config = await getConfig();
  let context = 'Datos actualizados de la clínica (usá solo esta información, no inventes):\n\n';

  context += 'Servicios y precios:\n';
  for (const servicio of config.servicios) {
    context += `- ${servicio.nombre}: $${servicio.precio.toLocaleString('es-AR')} (${servicio.duracionMinutos} min)\n`;
  }

  context += '\nProfesionales y horarios:\n';
  for (const [profesional, schedule] of Object.entries(config.profesionales)) {
    context += `${profesional}:\n`;
    const days = Object.keys(schedule).map(Number).sort((a, b) => a - b);
    for (const day of days) {
      const slots = schedule[day];
      const slotText = slots.map(slot => `${slot.inicio} a ${slot.fin}`).join(' y ');
      context += `  - ${DAY_NAMES[day]}: ${slotText}\n`;
    }
  }

  context += '\nAtención particular. NO se recibe obra social.\n';
  return context;
}

async function getGroqResponse(
  userMessage: string,
  estado: ConversationState,
  chatId: number
): Promise<AIResponse> {
  const GROQ_API_KEY = process.env.GROQ_API_KEY?.trim();
  if (!GROQ_API_KEY) {
    return {
      responseText: '',
      intent: { action: 'unknown' },
      shouldContinueWithFlow: false
    };
  }

  const clinicContext = await buildClinicContextForAI();

  const flowState = estado?.paso ? `
⚠️ FLUJO ACTIVO - El usuario está reservando ahora mismo:
- Paso actual: ${estado.paso}
- Profesional: ${estado.profesional || 'no elegido'}
- Servicio: ${estado.servicio || 'no elegido'}
- Nombre: ${estado.nombre || 'no indicado'}
- Fecha: ${estado.fecha || 'no elegida'}
- Hora: ${estado.hora || 'no elegida'}
- Reprogramando: ${estado.rescheduleId ? 'sí' : 'no'}
Si el mensaje responde al paso actual → shouldContinueWithFlow: true, action: "reservar", extraé el parámetro.` : '';

  const systemPrompt = `Sos el asistente virtual de una clínica de quiropraxia y masajes en Argentina (2026).
Tu rol es ENTENDER el mensaje, responder con calidez y CLASIFICAR la intención correctamente.

⚠️ REGLA MÁS IMPORTANTE: NO hagas preguntas sobre fecha, hora, profesional ni servicio en responseText.
El sistema tiene botones y menús para eso. Solo respondé brevemente y clasificá.

${clinicContext}

REGLAS DE CLASIFICACIÓN:
- Usuario quiere reservar un turno (aunque sea conversacional) → action: "reservar"
- Usuario responde al paso actual del flujo de reserva → action: "reservar", shouldContinueWithFlow: true
- Usuario solo pregunta algo sin intención de reservar → action: "consulta"
- Usuario saluda o pide menú → action: "menu"
- Usuario menciona "mis reservas" → action: "misreservas"

EXTRACCIÓN DE PARÁMETROS (siempre intentá extraer):
- profesional: si mencionó un profesional de la lista
- servicio: si mencionó un servicio (quiropraxia = "Sesión de Quiropraxia", masaje = "Masaje Relajante", premium = "Sesión Premium")
- fecha: convierte a YYYY-MM-DD (hoy=${new Date().toISOString().split('T')[0]})
- nombre: si el usuario dijo su nombre

${flowState}

Respondé SOLO con JSON válido:
{
  "responseText": "respuesta corta y cálida, 1-2 oraciones máximo, sin preguntas de booking",
  "intent": {
    "action": "menu"|"reservar"|"misreservas"|"servicios"|"profesionales"|"consulta"|"unknown",
    "parameters": {
      "profesional": null,
      "servicio": null,
      "fecha": null,
      "nombre": null
    }
  },
  "shouldContinueWithFlow": false
}`;

  const chatHistory = await getChatHistory(chatId, kv);
  const formattedHistory = formatChatHistoryForPrompt(chatHistory);

  try {
    const { data } = await axios.post(
      'https://api.groq.com/openai/v1/chat/completions',
      {
        model: process.env.GROQ_MODEL?.trim() || 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `${formattedHistory}${flowState}\nMensaje del usuario: ${userMessage}`.trim() }
        ],
        temperature: 0.4,
        response_format: { type: 'json_object' }
      },
      {
        headers: {
          Authorization: `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const text = data.choices?.[0]?.message?.content || '';
    const cleanedText = text.replace(/```json|```/g, '').trim();

    try {
      return JSON.parse(cleanedText) as AIResponse;
    } catch {
      return {
        responseText: text,
        intent: { action: 'unknown' },
        shouldContinueWithFlow: false
      };
    }
  } catch (error) {
    console.error('Error with Groq:', error);
    return {
      responseText: '',
      intent: { action: 'unknown' },
      shouldContinueWithFlow: false
    };
  }
}

async function resolveTextIntent(
  text: string,
  estado: ConversationState,
  chatId: number
): Promise<AIResponse> {
  const aiResult = await getGroqResponse(text, estado, chatId);
  const hasAIResponse = Boolean(aiResult.responseText?.trim());
  const hasKnownIntent = aiResult.intent.action !== 'unknown';

  if (hasKnownIntent || hasAIResponse) {
    return aiResult;
  }

  const localIntent = parseLocalIntent(text);
  if (localIntent) {
    return { responseText: '', intent: localIntent, shouldContinueWithFlow: false };
  }

  return aiResult;
}

async function buildMisReservasKeyboard(reservasArray: Reservation[]) {
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];

  for (const reservation of reservasArray) {
    keyboard.push([
      { text: `${reservation.servicio} — ${formatDate(reservation.fecha)} ${reservation.hora}`, callback_data: 'noop' }
    ]);
    keyboard.push([
      { text: '🔄 Cambiar', callback_data: `reprogramar:${reservation.id}` },
      { text: '❌ Eliminar', callback_data: `eliminar:${reservation.id}` }
    ]);
  }

  keyboard.push([{ text: '🏠 Menú', callback_data: 'menu' }]);
  return keyboard;
}

async function getRescheduleOptions(chatId: number, rescheduleId?: string) {
  if (!rescheduleId) return {};
  const reserva = await getReservaById(chatId, rescheduleId);
  return {
    excludeReservaId: rescheduleId,
    excludeEventId: reserva?.calendarEventId,
  };
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
        let state: ConversationState = { paso: null };

        if (kv) {
          const kvEstado = await kv.get(estadoKey);
          if (kvEstado) {
            state = typeof kvEstado === 'string' ? JSON.parse(kvEstado) : kvEstado;
          }
        } else {
          state = localStorage.get(estadoKey) || { paso: null };
        }

        if (state.updatedAt && Date.now() - state.updatedAt > STATE_TTL_MS) {
          return { paso: null };
        }

        return state;
      };

      const saveState = async (newState: ConversationState) => {
        const payload = { ...newState, updatedAt: Date.now() };
        if (kv) {
          await kv.set(estadoKey, JSON.stringify(payload), { ex: 1800 });
        } else {
          localStorage.set(estadoKey, payload);
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
        await sendWithKeyboard(
          '¡Hola! 👋 Soy el asistente de la clínica.\n\n¿En qué puedo ayudarte hoy?\n*(Atención particular, sin obra social)*',
          [
          [{ text: '📋 Ver profesionales', callback_data: 'profesionales' }],
          [{ text: '📋 Ver servicios', callback_data: 'servicios' }],
          [{ text: '📅 Reservar turno', callback_data: 'reservar' }],
          [{ text: '📋 Mis reservas', callback_data: 'misreservas' }]
        ]);

      } else if (data === 'profesionales') {
        const profesionales = await getProfesionales();
        await sendWithKeyboard(
          '👨‍⚕️ *Nuestros profesionales:*\n\n*(Atención particular, sin obra social)*',
          profesionales.map(p => [{ text: p, callback_data: `profesional:${p}` }])
        );
      } else if (data === 'servicios') {
        const servicios = await getServiciosList();
        await sendWithKeyboard(
          '🩺 *Servicios disponibles:*\n\n*(Atención particular, sin obra social)*',
          servicios.map(s => [{ text: `${s.nombre} ($${s.precio})`, callback_data: 'noop' }])
        );

      } else if (data === 'reservar') {
        const limitReached = await checkReservationLimit(chatId);
        if (limitReached) {
          await sendWithKeyboard(
            '⚠️ *Límite de reservas alcanzado*\n\nYa tenés el máximo de turnos activos permitidos. Para reservar uno nuevo, primero tenés que cancelar alguno desde tus reservas.',
            [[{ text: '📋 Mis reservas', callback_data: 'misreservas' }], [{ text: '🏠 Menú', callback_data: 'menu' }]]
          );
        } else {
          const profesionales = await getProfesionales();
          await saveState({ paso: 'profesional' });
          await sendWithKeyboard(
            '¿Con qué profesional te querés atender?',
            profesionales.map(p => [{ text: p, callback_data: `profesional:${p}` }])
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
          const keyboard = await buildMisReservasKeyboard(reservasArray);
          await sendWithKeyboard('📋 *Tus reservas:*', keyboard);
        }

      } else if (data.startsWith('reprogramar:')) {
        const reservaId = data.replace('reprogramar:', '');
        const reserva = await getReservaById(chatId, reservaId);

        if (!reserva) {
          await sendWithKeyboard('No encontré esa reserva.', [[{ text: '🏠 Menú', callback_data: 'menu' }]]);
        } else {
          await saveState({
            paso: 'fecha',
            rescheduleId: reservaId,
            profesional: reserva.profesional,
            servicio: reserva.servicio,
            nombre: reserva.nombre,
            fecha: reserva.fecha,
            hora: reserva.hora,
          });
          const view = await buildFechasView(reserva.servicio, reserva.profesional);
          await sendWithKeyboard(`🔄 *Cambiar turno*\n\nElegí la nueva fecha:\n\n${view.text}`, view.keyboard);
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
        const servicios = await getServiciosList();
        await saveState({ paso: 'servicio', profesional: profSeleccionado });
        await sendWithKeyboard(
          `*${profSeleccionado}* ✔️\n\n¿Qué servicio querés reservar?`,
          servicios.map(s => [{ text: s.nombre, callback_data: `servicio:${s.nombre}` }])
        );
      } else if (data.startsWith('servicio:')) {
        const servicioSeleccionado = data.replace('servicio:', '');
        const profile = await getUserProfile(chatId, kv);
        const nombreGuardado = estado.nombre || profile?.nombre;

        if (nombreGuardado && estado.fecha && estado.profesional) {
          await saveState({ ...estado, paso: 'hora', servicio: servicioSeleccionado, nombre: nombreGuardado });
          const view = await buildHorariosView(
            estado.fecha,
            servicioSeleccionado,
            estado.profesional,
            estado.rescheduleId
          );
          await sendWithKeyboard(view.text, view.keyboard);
        } else if (nombreGuardado) {
          await saveState({ ...estado, paso: 'fecha', servicio: servicioSeleccionado, nombre: nombreGuardado });
          const view = await buildFechasView(servicioSeleccionado, estado.profesional);
          await sendWithKeyboard(`Hola *${nombreGuardado}* 👋\n\n${view.text}`, view.keyboard);
        } else {
          await saveState({ ...estado, paso: 'nombre', servicio: servicioSeleccionado });
          await sendWithKeyboard(`*${servicioSeleccionado}* ✔️\n\n¿Cuál es tu nombre?`);
        }

      } else if (data === 'cambiar_fecha') {
        await saveState({
          paso: 'fecha',
          servicio: estado.servicio,
          nombre: estado.nombre,
          profesional: estado.profesional,
          rescheduleId: estado.rescheduleId,
        });
        const view = await buildFechasView(estado.servicio, estado.profesional);
        await sendWithKeyboard(view.text, view.keyboard);

      } else if (data.startsWith('fecha:')) {
        const fechaSeleccionada = data.replace('fecha:', '');
        if (estado.servicio && estado.profesional) {
          await saveState({ ...estado, paso: 'hora', fecha: fechaSeleccionada });
          const view = await buildHorariosView(
            fechaSeleccionada,
            estado.servicio,
            estado.profesional,
            estado.rescheduleId
          );
          await sendWithKeyboard(view.text, view.keyboard);
        }

      } else if (data === 'refresh_horarios') {
        if (estado.fecha && estado.servicio && estado.profesional) {
          const view = await buildHorariosView(
            estado.fecha,
            estado.servicio,
            estado.profesional,
            estado.rescheduleId
          );
          await sendWithKeyboard(view.text, view.keyboard);
        }

      } else if (data.startsWith('hora:')) {
        const horaSeleccionada = data.replace('hora:', '');
        const rescheduleOptions = await getRescheduleOptions(chatId, estado.rescheduleId);

        const disponibilidad = await verificarDisponibilidad(
          estado.profesional!,
          estado.servicio!,
          estado.fecha!,
          horaSeleccionada,
          rescheduleOptions
        );

        if (disponibilidad.disponible) {
          await saveState({ ...estado, paso: 'confirmar', hora: horaSeleccionada });
          const view = await buildConfirmacionView({ ...estado, hora: horaSeleccionada });
          await sendWithKeyboard(view.text, view.keyboard);
        } else {
          const viewActualizada = await buildHorariosView(
            estado.fecha!,
            estado.servicio!,
            estado.profesional!,
            estado.rescheduleId
          );
          await sendWithKeyboard(
            `⚠️ ${disponibilidad.mensaje || 'Ese horario no está disponible.'}\n\nElegí otro turno:`,
            viewActualizada.keyboard
          );
        }

      } else if (data === 'confirmar_reprogramar') {
        if (!estado.rescheduleId || !estado.fecha || !estado.hora) {
          await sendWithKeyboard('No pude reprogramar ese turno. Probá de nuevo desde *Mis reservas*.', [
            [{ text: '📋 Mis reservas', callback_data: 'misreservas' }]
          ]);
        } else {
          const rescheduleOptions = await getRescheduleOptions(chatId, estado.rescheduleId);
          const disponibilidad = await verificarDisponibilidad(
            estado.profesional!,
            estado.servicio!,
            estado.fecha!,
            estado.hora!,
            rescheduleOptions
          );

          if (disponibilidad.disponible) {
            const reserva = await reprogramarReserva(chatId, estado.rescheduleId, estado.fecha, estado.hora);

            if (reserva) {
              await clearState();
              await sendWithKeyboard(
                `🔄 *Turno reprogramado*\n\n` +
                  `👨‍⚕️ ${reserva.profesional}\n` +
                  `✨ *${reserva.servicio}*\n` +
                  `📅 ${formatDate(reserva.fecha)}\n` +
                  `🕐 ${reserva.hora}\n\n` +
                  `Te vamos a enviar recordatorios antes del turno.`,
                [
                  [{ text: '📋 Mis reservas', callback_data: 'misreservas' }],
                  [{ text: '🏠 Menú', callback_data: 'menu' }]
                ]
              );
            } else {
              const viewActualizada = await buildHorariosView(
                estado.fecha!,
                estado.servicio!,
                estado.profesional!,
                estado.rescheduleId
              );
              await sendWithKeyboard(
                '⚠️ Ese horario ya no está disponible.\n\nElegí otro turno:',
                viewActualizada.keyboard
              );
            }
          } else {
            const viewActualizada = await buildHorariosView(
              estado.fecha!,
              estado.servicio!,
              estado.profesional!,
              estado.rescheduleId
            );
            await sendWithKeyboard(
              `⚠️ ${disponibilidad.mensaje || 'Ese horario ya no está disponible.'}\n\nElegí otro turno:`,
              viewActualizada.keyboard
            );
          }
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
              `¡Nos vemos! 😊\n\nTe vamos a enviar recordatorios antes del turno.`,
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

      await appendChatMessage(chatId, 'user', text, kv);

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
          await appendChatMessage(chatId, 'assistant', t, kv);
        } catch (e: any) {
          console.error('❌ Error al enviar mensaje:', e.message);
          if (e.response) {
            console.error('Response data:', JSON.stringify(e.response.data, null, 2));
          }
        }
      };

      const MAIN_MENU_KEYBOARD = [
        [{ text: '📋 Ver profesionales', callback_data: 'profesionales' }],
        [{ text: '📋 Ver servicios', callback_data: 'servicios' }],
        [{ text: '📅 Reservar turno', callback_data: 'reservar' }],
        [{ text: '📋 Mis reservas', callback_data: 'misreservas' }]
      ];

      const showMainMenu = async (intro?: string) => {
        await sendWithKeyboard(
          intro ||
            '¡Hola! 👋 Soy el asistente de la clínica.\n\n¿En qué puedo ayudarte hoy?\n*(Atención particular, sin obra social)*',
          MAIN_MENU_KEYBOARD
        );
      };

      const showInfoResponse = async (infoType: 'obra_social' | 'horarios' | 'precios') => {
        if (infoType === 'obra_social') {
          await sendWithKeyboard(
            '🏥 *Obra social*\n\nEn este momento *no recibimos obra social*. La atención es *particular*.\n\nSi querés, puedo mostrarte servicios, horarios o ayudarte a reservar un turno.',
            ASSIST_KEYBOARD
          );
        } else if (infoType === 'horarios') {
          await sendWithKeyboard(await buildHorariosInfoMessage(), ASSIST_KEYBOARD);
        } else {
          await sendWithKeyboard(await buildPreciosInfoMessage(), ASSIST_KEYBOARD);
        }
      };


      const showHorarios = async (fechaStr: string, servicio: string, profesional: string) => {
        await saveState({ ...estado, paso: 'hora', servicio, nombre: estado.nombre, fecha: fechaStr, profesional });
        const view = await buildHorariosView(fechaStr, servicio, profesional, estado.rescheduleId);
        await sendWithKeyboard(view.text, view.keyboard);
      };

      let aiResult = await resolveTextIntent(text, estado, chatId);

      if (aiResult.intent.action === 'consulta') {
        await clearState();
        if (aiResult.responseText?.trim()) {
          await sendWithKeyboard(aiResult.responseText, ASSIST_KEYBOARD);
        } else {
          const consultaInfo = parseInfoQuery(text);
          if (consultaInfo) {
            await showInfoResponse(consultaInfo);
          } else {
            await sendWithKeyboard(
              'Con gusto te ayudo. Por el momento la atención es *particular* y *no recibimos obra social*.\n\nPodés consultar horarios, servicios o reservar un turno.',
              ASSIST_KEYBOARD
            );
          }
        }
      } else if (aiResult.intent.action !== 'unknown' && !aiResult.shouldContinueWithFlow) {
        if (aiResult.intent.action === 'menu') {
          await clearState();
          await showMainMenu(aiResult.responseText?.trim());
        } else if (aiResult.intent.action === 'servicios') {
          const servicios = await getServiciosList();
          await sendWithKeyboard(
            aiResult.responseText?.trim() ||
              '🩺 *Servicios disponibles:*\n\n*(Atención particular, sin obra social)*',
            servicios.map(s => [{ text: `${s.nombre} ($${s.precio})`, callback_data: 'noop' }])
          );
        } else if (aiResult.intent.action === 'profesionales') {
          const profesionales = await getProfesionales();
          await sendWithKeyboard(
            aiResult.responseText?.trim() ||
              '👨‍⚕️ *Nuestros profesionales:*\n\n*(Atención particular, sin obra social)*',
            profesionales.map(p => [{ text: p, callback_data: `profesional:${p}` }])
          );
        } else if (aiResult.intent.action === 'misreservas') {
          let reservasArray: Reservation[] = [];

          if (kv) {
            const userReservasKey = `user:${chatId}:reservas`;
            const userReservas = await kv.get(userReservasKey) || [];
            let rawArray = Array.isArray(userReservas) ? userReservas : JSON.parse(userReservas as string);
            
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
            const keyboard = await buildMisReservasKeyboard(reservasArray);
            await sendWithKeyboard('📋 *Tus reservas:*', keyboard);
          }
        } else if (aiResult.intent.action === 'reservar') {
          const limitReached = await checkReservationLimit(chatId);
          if (limitReached) {
            await sendWithKeyboard(
              '⚠️ *Límite de reservas alcanzado*\n\nYa tenés el máximo de turnos activos permitidos. Para reservar uno nuevo, primero tenés que cancelar alguno desde tus reservas.',
              [[{ text: '📋 Mis reservas', callback_data: 'misreservas' }], [{ text: '🏠 Menú', callback_data: 'menu' }]]
            );
          } else {
            const profesionales = await getProfesionales();
            const profile = await getUserProfile(chatId, kv);

            let newEstado: ConversationState = { paso: 'profesional' };
            
            if (aiResult.intent.parameters?.profesional) {
              // Find the professional
              const prof = profesionales.find(p =>
                matchesLoosely(p, aiResult.intent.parameters!.profesional!)
              );
              if (prof) {
                newEstado.profesional = prof;
                newEstado.paso = 'servicio';
              }
            }
            
            if (aiResult.intent.parameters?.servicio) {
              const servicios = await getServiciosList();
              const serv = servicios.find(s =>
                matchesLoosely(s.nombre, aiResult.intent.parameters!.servicio!)
              );
              if (serv) {
                newEstado.servicio = serv.nombre;
                if (newEstado.paso === 'servicio') {
                  newEstado.paso = 'nombre';
                }
              }
            }
            
            if (aiResult.intent.parameters?.nombre) {
              newEstado.nombre = aiResult.intent.parameters.nombre;
              if (newEstado.paso === 'nombre') {
                newEstado.paso = 'fecha';
              }
            } else if (profile?.nombre && newEstado.paso === 'nombre') {
              newEstado.nombre = profile.nombre;
              newEstado.paso = 'fecha';
            }
            
            if (aiResult.intent.parameters?.fecha) {
              newEstado.fecha = aiResult.intent.parameters.fecha;
              if (newEstado.paso === 'fecha' && newEstado.profesional && newEstado.servicio) {
                newEstado.paso = 'hora';
              }
            }
            
            await saveState(newEstado);
            
            // Now show the appropriate view
            if (newEstado.paso === 'profesional') {
              await sendWithKeyboard(
                aiResult.responseText?.trim() || '¿Con qué profesional te querés atender?',
                profesionales.map(p => [{ text: p, callback_data: `profesional:${p}` }])
              );
            } else if (newEstado.paso === 'servicio') {
              const servicios = await getServiciosList();
              await sendWithKeyboard(
                `*${newEstado.profesional}* ✔️\n\n¿Qué servicio querés reservar?`,
                servicios.map(s => [{ text: s.nombre, callback_data: `servicio:${s.nombre}` }])
              );
            } else if (newEstado.paso === 'nombre') {
              await sendWithKeyboard(`*${newEstado.servicio}* ✔️\n\n¿Cuál es tu nombre?`);
            } else if (newEstado.paso === 'fecha') {
              const view = await buildFechasView(newEstado.servicio, newEstado.profesional);
              await sendWithKeyboard(`Hola *${newEstado.nombre}* 👋\n\n${view.text}`, view.keyboard);
            } else if (newEstado.paso === 'hora') {
              const view = await buildHorariosView(newEstado.fecha!, newEstado.servicio!, newEstado.profesional!);
              await sendWithKeyboard(view.text, view.keyboard);
            }
          }
        } else {
          await sendWithKeyboard(aiResult.responseText);
        }
      } else if (estado?.paso && (aiResult.shouldContinueWithFlow || isValidFlowInput(text, estado.paso))) {
        console.log('Continuing with existing flow, estado:', estado);

        if (estado.paso === 'profesional') {
          const profesionales = await getProfesionales();
          let profSeleccionado = null;
          const num = parseInt(text);
          if (!isNaN(num) && num >= 1 && num <= profesionales.length) {
            profSeleccionado = profesionales[num - 1];
          } else {
            profSeleccionado = profesionales.find(p => matchesLoosely(p, text));
          }
          if (profSeleccionado) {
            const servicios = await getServiciosList();
            await saveState({ paso: 'servicio', profesional: profSeleccionado });
            await sendWithKeyboard(
              `*${profSeleccionado}* ✔️\n\n¿Qué servicio querés reservar?`,
              servicios.map(s => [{ text: s.nombre, callback_data: `servicio:${s.nombre}` }])
            );
          } else {
            await sendWithKeyboard('Elegí un profesional válido:', profesionales.map(p => [{ text: p, callback_data: `profesional:${p}` }]));
          }
        } else if (estado.paso === 'servicio') {
          const servicios = await getServiciosList();
          let servicioSeleccionado = null;
          const num = parseInt(text);
          if (!isNaN(num) && num >= 1 && num <= servicios.length) {
            servicioSeleccionado = servicios[num - 1].nombre;
          } else {
            servicioSeleccionado = servicios.find(s => matchesLoosely(s.nombre, text))?.nombre;
          }

          if (servicioSeleccionado) {
            await saveState({ ...estado, paso: 'nombre', servicio: servicioSeleccionado });
            await sendWithKeyboard(`*${servicioSeleccionado}* ✔️\n\n¿Cuál es tu nombre?`);
          } else {
            await sendWithKeyboard(
              'No reconozco ese servicio. Por favor elegí uno:',
              servicios.map(s => [{ text: s.nombre, callback_data: `servicio:${s.nombre}` }])
            );
          }

        } else if (estado.paso === 'nombre') {
          await saveState({ ...estado, paso: 'fecha', nombre: text });
          await saveUserProfile(chatId, text, kv);
          const view = await buildFechasView(estado.servicio, estado.profesional);
          await sendWithKeyboard(`Hola *${text}* 👋\n\n${view.text}`, view.keyboard);

        } else if (estado.paso === 'fecha') {
          const fechaParseada = parseFecha(text);
          let esDiaValido = false;
          if (fechaParseada) {
            esDiaValido = await esDiaLaborable(fechaParseada, estado.profesional);
          }
          if (fechaParseada && esDiaValido) {
            await showHorarios(fechaParseada, estado.servicio!, estado.profesional!);
          } else if (fechaParseada && !esDiaValido) {
            const keyboard = await buildFechasKeyboard(estado.profesional);
            await sendWithKeyboard(
              '❌ El profesional no atiende ese día. Elegí otro:',
              keyboard
            );
          } else {
            const view = await buildFechasView(estado.servicio, estado.profesional);
            await sendWithKeyboard('No pude interpretar esa fecha. Elegí un día de la lista:', view.keyboard);
          }

        } else if (estado.paso === 'hora') {
          const horariosLibres = await obtenerHorariosLibres(
            estado.fecha!,
            estado.profesional!,
            estado.servicio!,
            estado.rescheduleId
          );
          let horaSeleccionada: string | null = null;

          // Manejo de preferencia de turno: "mañana" o "tarde"
          const normalizedPeriod = normalizeHumanText(text);
          const wantsMorning = ['manana', 'mañana', 'morning', 'por la manana', 'por la mañana', 'la manana', 'la mañana'].some(w => normalizedPeriod.includes(w));
          const wantsAfternoon = ['tarde', 'afternoon', 'por la tarde', 'la tarde'].some(w => normalizedPeriod.includes(w));

          if (wantsMorning || wantsAfternoon) {
            const filtered = horariosLibres.filter(h => {
              const hour = parseInt(h.split(':')[0]);
              return wantsMorning ? hour < 13 : hour >= 13;
            });
            if (filtered.length > 0) {
              const keyboard: any[] = [];
              for (let i = 0; i < filtered.length; i += 3) {
                keyboard.push(filtered.slice(i, i + 3).map(h => ({ text: `🕐 ${h}`, callback_data: `hora:${h}` })));
              }
              keyboard.push([{ text: '📅 Ver todos', callback_data: 'refresh_horarios' }, { text: '🏠 Menú', callback_data: 'menu' }]);
              const period = wantsMorning ? 'la mañana' : 'la tarde';
              await sendWithKeyboard(`⏰ Turnos disponibles por ${period}:`, keyboard);
            } else {
              const period = wantsMorning ? 'la mañana' : 'la tarde';
              const view = await buildHorariosView(estado.fecha!, estado.servicio!, estado.profesional!, estado.rescheduleId);
              await sendWithKeyboard(`😕 No hay turnos disponibles por ${period}. Todos los horarios disponibles:`, view.keyboard);
            }
            return NextResponse.json({ status: 'ok' });
          }

          const num = parseInt(text);
          if (!isNaN(num) && num >= 1 && num <= horariosLibres.length) {
            horaSeleccionada = horariosLibres[num - 1];
          } else {
            horaSeleccionada = horariosLibres.find(h =>
              h.includes(text) || text.includes(h)
            ) ?? null;
          }

          if (horaSeleccionada) {
            const rescheduleOptions = await getRescheduleOptions(chatId, estado.rescheduleId);
            const disponibilidad = await verificarDisponibilidad(
              estado.profesional!,
              estado.servicio!,
              estado.fecha!,
              horaSeleccionada,
              rescheduleOptions
            );

            if (disponibilidad.disponible) {
              await saveState({ ...estado, paso: 'confirmar', hora: horaSeleccionada });
              const view = await buildConfirmacionView({ ...estado, hora: horaSeleccionada });
              await sendWithKeyboard(view.text, view.keyboard);
            } else {
              const viewActualizada = await buildHorariosView(
                estado.fecha!,
                estado.servicio!,
                estado.profesional!,
                estado.rescheduleId
              );
              await sendWithKeyboard(
                `⚠️ ${disponibilidad.mensaje || 'Ese horario no está disponible.'}\n\nElegí otro turno:`,
                viewActualizada.keyboard
              );
            }
          } else {
            await showHorarios(estado.fecha!, estado.servicio!, estado.profesional!);
          }

        } else if (estado.paso === 'confirmar') {
          const normalizedConfirm = normalizeHumanText(text);
          const confirmWords = ['si', 'sí', 'dale', 'confirmar', 'confirmo', 'ok', 'listo', 'yes', 'bueno', 'va'];
          const cancelWords = ['no', 'cancelar', 'cancel', 'nop', 'nope'];

          if (confirmWords.includes(normalizedConfirm)) {
            // Tratar como confirmar_reserva / confirmar_reprogramar por texto
            const disponibilidad = await verificarDisponibilidad(
              estado.profesional!, estado.servicio!, estado.fecha!, estado.hora!
            );
            if (disponibilidad.disponible) {
              if (estado.rescheduleId) {
                const reserva = await reprogramarReserva(chatId, estado.rescheduleId, estado.fecha!, estado.hora!);
                if (reserva) {
                  await clearState();
                  await sendWithKeyboard(
                    `🔄 *Turno reprogramado*\n\n👨‍⚕️ ${reserva.profesional}\n✨ *${reserva.servicio}*\n📅 ${formatDate(reserva.fecha)}\n🕐 ${reserva.hora}\n\nTe enviamos recordatorios antes del turno.`,
                    [[{ text: '📋 Mis reservas', callback_data: 'misreservas' }], [{ text: '🏠 Menú', callback_data: 'menu' }]]
                  );
                }
              } else {
                const reserva = await guardarReserva(chatId, {
                  profesional: estado.profesional!,
                  servicio: estado.servicio!,
                  nombre: estado.nombre!,
                  fecha: estado.fecha!,
                  hora: estado.hora!,
                  chatId
                });
                if (reserva) {
                  await clearState();
                  await sendWithKeyboard(
                    `🎉 *¡Reserva confirmada!*\n\n👨‍⚕️ ${reserva.profesional}\n✨ *${reserva.servicio}*\n📅 ${formatDate(reserva.fecha)}\n🕐 ${reserva.hora}\n👤 ${reserva.nombre}\n\n¡Nos vemos! 😊`,
                    [[{ text: '📋 Mis reservas', callback_data: 'misreservas' }], [{ text: '🏠 Menú', callback_data: 'menu' }]]
                  );
                } else {
                  const viewActualizada = await buildHorariosView(estado.fecha!, estado.servicio!, estado.profesional!);
                  await sendWithKeyboard(`⚠️ Ese horario acaba de ser reservado.\n\nElegí otro turno:`, viewActualizada.keyboard);
                }
              }
            } else {
              const viewActualizada = await buildHorariosView(estado.fecha!, estado.servicio!, estado.profesional!);
              await sendWithKeyboard(`⚠️ ${disponibilidad.mensaje || 'Ese horario ya no está disponible.'}\n\nElegí otro turno:`, viewActualizada.keyboard);
            }
          } else if (cancelWords.includes(normalizedConfirm)) {
            await clearState();
            await sendWithKeyboard('Cancelado. ¿En qué más puedo ayudarte?', ASSIST_KEYBOARD);
          } else {
            // Recordarle que use los botones
            const view = await buildConfirmacionView(estado);
            await sendWithKeyboard('Por favor usá los botones para confirmar o cancelar:\n\n' + view.text, view.keyboard);
          }
        }
      } else if (aiResult.responseText?.trim()) {
        if (estado?.paso) {
          // Hay un flujo activo: no limpiar el estado, mostrar botones contextuales
          const contextKeyboard = await getContextualKeyboard(estado);
          await sendWithKeyboard(aiResult.responseText, contextKeyboard);
        } else {
          await clearState();
          await sendWithKeyboard(aiResult.responseText, ASSIST_KEYBOARD);
        }
      } else if (estado?.paso) {
        await clearState();
        await sendWithKeyboard(
          'Interrumpí la reserva anterior para atender tu consulta. Si querés, podemos empezar de nuevo:',
          [
            [{ text: '📅 Reservar turno', callback_data: 'reservar' }],
            [{ text: '🏠 Menú principal', callback_data: 'menu' }]
          ]
        );
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
