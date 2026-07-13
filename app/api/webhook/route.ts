import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import { createClient } from '@vercel/kv';
import { getLocalReservations, addLocalReservation } from '../admin/reservations/route';
import {
  BotIntent,
  containsBookingIntent,
  isValidFlowInput,
  isValidPersonName,
  looksLikeQuestion,
  matchesLoosely,
  normalizeHumanText,
  parseInfoQuery,
  parseLocalIntent,
} from '@/lib/bot-intent';
import {
  BTN,
  buildBookingCard,
  buildSuccessMessage,
  capitalizeName,
  formatDateAR,
  formatPriceAR,
  getClinicAddress,
  getClinicMapsUrl,
  buildLocationMessage,
  shortBookingCode,
  withFlowProgress,
} from '@/lib/booking-copy';
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

  try {
    if (kv) {
      const key = `ratelimit:user:${chatId}`;
      const data = await kv.get(key) as { count: number; windowStart: number } | null;
      if (!data) {
        await kv.set(key, JSON.stringify({ count: 1, windowStart: now }), { ex: RATE_LIMIT_WINDOW });
        return false; // no bloqueado
      }
      const parsed = typeof data === 'string' ? JSON.parse(data) : data;
      const elapsed = now - (parsed.windowStart || now);

      if (elapsed >= RATE_LIMIT_WINDOW || elapsed < 0 || !Number.isFinite(elapsed)) {
        // ventana nueva
        await kv.set(key, JSON.stringify({ count: 1, windowStart: now }), { ex: RATE_LIMIT_WINDOW });
        return false;
      }

      if (parsed.count >= RATE_LIMIT_MAX) {
        return true; // bloqueado
      }

      parsed.count += 1;
      // Upstash rechaza ex <= 0 → siempre mínimo 1 segundo
      const ttl = Math.max(1, RATE_LIMIT_WINDOW - elapsed);
      await kv.set(key, JSON.stringify(parsed), { ex: ttl });
      return false;
    }

    const data = localRateLimit.get(chatId);
    if (!data) {
      localRateLimit.set(chatId, { count: 1, windowStart: now });
      return false;
    }

    const elapsed = now - data.windowStart;
    if (elapsed >= RATE_LIMIT_WINDOW) {
      localRateLimit.set(chatId, { count: 1, windowStart: now });
      return false;
    }

    if (data.count >= RATE_LIMIT_MAX) {
      return true;
    }

    data.count += 1;
    return false;
  } catch (error) {
    // Nunca tumbar el bot por un fallo de rate limit / KV
    console.error('Rate limit check failed:', error);
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

  // Normalizar nombre legacy "Quiropráctica" → "Quiropraxia"
  config.servicios = config.servicios.map(s => ({
    ...s,
    nombre: s.nombre.replace(/Quiropráctica/gi, 'Quiropraxia').replace(/quiropractica/gi, 'Quiropraxia')
  }));

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
  const normalized = normalizeHumanText(nombre).replace(/quiropractica/g, 'quiropraxia');
  return servicios.find(s => {
    const sNorm = normalizeHumanText(s.nombre).replace(/quiropractica/g, 'quiropraxia');
    return sNorm === normalized || sNorm.includes(normalized) || normalized.includes(sNorm);
  });
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
  return formatDateAR(fechaStr);
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
  keyboard.push([BTN.MENU]);
  return keyboard;
}

async function buildFechasView(servicio?: string, profesional?: string) {
  const header = servicio
    ? `📅 *${servicio}*${profesional ? `\n👨‍⚕️ ${profesional}` : ''}\n\n¿Qué día preferís?`
    : '📅 ¿Qué día te gustaría?';
  return {
    text: withFlowProgress('fecha', header),
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
  const serv = await getServicio(servicio);

  if (horariosLibres.length === 0) {
    // Sugerir próxima fecha con turnos
    const proximas = await proximosDiasLaborables(10, profesional);
    const siguientes: Array<{ fecha: string; label: string }> = [];
    for (const d of proximas) {
      if (d.fecha === fechaStr) continue;
      const libres = await obtenerHorariosLibres(d.fecha, profesional, servicio, excludeReservaId);
      if (libres.length > 0) {
        siguientes.push(d);
        if (siguientes.length >= 2) break;
      }
    }

    const keyboard: any[] = siguientes.map(d => [
      { text: `📅 Ver ${d.label}`, callback_data: `fecha:${d.fecha}` }
    ]);
    keyboard.push([{ text: '📅 Otra fecha', callback_data: 'cambiar_fecha' }]);
    keyboard.push([BTN.MENU]);

    return {
      text: withFlowProgress(
        'hora',
        `😕 No hay turnos libres para *${servicio}* el ${formatDate(fechaStr)} con ${profesional}.\n\n` +
          (siguientes.length
            ? 'Probá con una de estas fechas disponibles:'
            : 'Probá con otra fecha o volvé al menú:')
      ),
      keyboard
    };
  }

  const keyboard: any[] = [];
  for (let i = 0; i < horariosLibres.length; i += 3) {
    keyboard.push(
      horariosLibres.slice(i, i + 3).map(h => ({ text: `🕐 ${h}`, callback_data: `hora:${h}` }))
    );
  }
  keyboard.push([
    { text: '📅 Cambiar fecha', callback_data: 'cambiar_fecha' },
    BTN.MENU
  ]);

  const duracion = serv ? ` · ${serv.duracionMinutos} min` : '';
  return {
    text: withFlowProgress(
      'hora',
      `🗓 *${servicio}*${duracion}\n` +
        `👨‍⚕️ ${profesional}\n` +
        `📅 ${formatDate(fechaStr)}\n\n` +
        `⏰ Elegí un horario:`
    ),
    keyboard
  };
}

// ── Vista de confirmación ────────────────────────────────────────────────────
async function buildConfirmacionView(estado: ConversationState) {
  const serv = await getServicio(estado.servicio || '');
  const isReschedule = Boolean(estado.rescheduleId);
  const card = buildBookingCard({
    profesional: estado.profesional || '',
    servicio: estado.servicio || '',
    nombre: estado.nombre || '',
    fecha: estado.fecha!,
    hora: estado.hora!,
    duracionMinutos: serv?.duracionMinutos,
    precio: serv?.precio,
    includeDisclaimer: true,
  });

  return {
    text: withFlowProgress(
      'confirmar',
      `${isReschedule ? '🔄 *Confirmá el cambio de turno*' : '✅ *Revisá tu turno*'}\n\n` +
        `${card}\n\n` +
        `${isReschedule ? '¿Confirmás el cambio?' : '¿Todo correcto? Confirmá y listo.'}`
    ),
    keyboard: [
      [
        { text: '✅ Confirmar', callback_data: isReschedule ? 'confirmar_reprogramar' : 'confirmar_reserva' },
      ],
      [
        { text: '🕐 Cambiar horario', callback_data: 'refresh_horarios' },
        { text: '📅 Cambiar fecha', callback_data: 'cambiar_fecha' },
      ],
      [BTN.CANCEL_FLOW]
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
    return { disponible: false, mensaje: 'Error al verificar disponibilidad. Intentá más tarde.' };
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
const WELCOME_MESSAGE =
  '¡Hola! 👋 Soy el asistente de la clínica.\n\n' +
  '¿En qué puedo ayudarte hoy?\n' +
  '*(Atención particular, sin obra social)*';

const MAIN_MENU_KEYBOARD = [
  [{ text: '📋 Ver profesionales', callback_data: 'profesionales' }],
  [{ text: '📋 Ver servicios', callback_data: 'servicios' }],
  [{ text: '📅 Reservar turno', callback_data: 'reservar' }],
  [{ text: '📋 Mis reservas', callback_data: 'misreservas' }]
];

const ASSIST_KEYBOARD = [
  [BTN.RESERVAR],
  [{ text: '📋 Ver servicios', callback_data: 'servicios' }, BTN.MENU]
];

const FLOW_CANCEL_KEYBOARD = [[BTN.CANCEL_FLOW]];

async function buildProfesionalesKeyboard() {
  const profesionales = await getProfesionales();
  return [
    ...profesionales.map(p => [{ text: p, callback_data: `profesional:${p}` }]),
    [{ text: '🎲 Al azar', callback_data: 'aleatorio_profesional' }],
    [BTN.MENU]
  ];
}

async function buildServiciosKeyboard(forBooking = true) {
  const servicios = await getServiciosList();
  // Índices cortos: evita límites de callback_data de Telegram (64 bytes)
  const prefix = forBooking ? 'servicio_idx:' : 'rsvc_idx:';
  const rows = servicios.map((s, i) => [{
    text: `${s.nombre} (${formatPriceAR(s.precio)})`,
    callback_data: `${prefix}${i}`
  }]);
  if (forBooking) {
    rows.push([{ text: '🎲 Al azar', callback_data: 'aleatorio_servicio' }]);
  }
  rows.push([BTN.MENU]);
  return rows;
}

async function resolveServicioFromCallback(data: string): Promise<string | null> {
  if (data.startsWith('servicio_idx:') || data.startsWith('rsvc_idx:')) {
    const idx = parseInt(data.split(':')[1] || '', 10);
    const servicios = await getServiciosList();
    if (!Number.isNaN(idx) && servicios[idx]) return servicios[idx].nombre;
    return null;
  }
  if (data.startsWith('reservar_servicio:')) return data.replace('reservar_servicio:', '');
  if (data.startsWith('servicio:')) return data.replace('servicio:', '');
  return null;
}

/** Después de elegir profesional: seguir al nombre/fecha si ya hay servicio. */
async function continueAfterProfessional(
  chatId: number,
  estado: ConversationState,
  profSeleccionado: string,
  saveState: (s: ConversationState) => Promise<void>,
  sendWithKeyboard: (t: string, k?: any) => Promise<void>,
  prefix = ''
) {
  const intro = prefix || `*${profSeleccionado}* ✔️\n\n`;

  if (estado.servicio) {
    if (estado.nombre || estado.rescheduleId) {
      const nombre = estado.nombre!;
      await saveState({
        ...estado,
        paso: 'fecha',
        profesional: profSeleccionado,
        nombre,
      });
      const view = await buildFechasView(estado.servicio, profSeleccionado);
      await sendWithKeyboard(`${intro}Hola *${nombre}* 👋\n\n${view.text}`, view.keyboard);
    } else {
      const step = await buildNombreStep(
        { ...estado, profesional: profSeleccionado },
        chatId,
        intro
      );
      await saveState(step.estado);
      await sendWithKeyboard(step.text, step.keyboard);
    }
    return;
  }

  // Sin servicio aún → pedirlo (profesional ya queda guardado)
  await saveState({ ...estado, paso: 'servicio', profesional: profSeleccionado });
  await sendWithKeyboard(
    withFlowProgress('servicio', `${intro}¿Qué servicio querés reservar?`),
    await buildServiciosKeyboard(true)
  );
}

async function getContextualKeyboard(estado: ConversationState, _chatId?: number): Promise<any[][]> {
  switch (estado.paso) {
    case 'profesional':
      return buildProfesionalesKeyboard();
    case 'servicio':
      return buildServiciosKeyboard(true);
    case 'nombre':
      return FLOW_CANCEL_KEYBOARD;
    case 'fecha':
      return await buildFechasKeyboard(estado.profesional);
    case 'hora': {
      if (estado.fecha && estado.servicio && estado.profesional) {
        const view = await buildHorariosView(estado.fecha, estado.servicio, estado.profesional, estado.rescheduleId);
        return view.keyboard;
      }
      return FLOW_CANCEL_KEYBOARD;
    }
    case 'confirmar': {
      const view = await buildConfirmacionView(estado);
      return view.keyboard;
    }
    default:
      return ASSIST_KEYBOARD;
  }
}

/** Pide nombre o confirma el del perfil (precisión / wow). */
async function buildNombreStep(estado: ConversationState, chatId: number, prefix = '') {
  const profile = await getUserProfile(chatId, kv);
  const known = estado.nombre || profile?.nombre;

  if (known) {
    return {
      estado: { ...estado, paso: 'nombre', nombre: known } as ConversationState,
      text: withFlowProgress(
        'nombre',
        `${prefix}¿Reservo a nombre de *${known}*?`
      ),
      keyboard: [
        [{ text: `✅ Sí, soy ${known.split(' ')[0]}`, callback_data: 'usar_nombre' }],
        [{ text: '✏️ Otro nombre', callback_data: 'cambiar_nombre' }],
        [BTN.CANCEL_FLOW]
      ]
    };
  }

  return {
    estado: { ...estado, paso: 'nombre', nombre: undefined } as ConversationState,
    text: withFlowProgress('nombre', `${prefix}¿Cuál es tu nombre?`),
    keyboard: FLOW_CANCEL_KEYBOARD
  };
}

const POST_BOOKING_KEYBOARD = [[BTN.MIS_RESERVAS], [BTN.MENU]];

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
  context += `Dirección: ${getClinicAddress()}\n`;
  context += `Mapa: ${getClinicMapsUrl()}\n`;
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
Si el mensaje responde al paso actual → shouldContinueWithFlow: true, action: "reservar", extraé el parámetro.
Si NO hay respuesta al paso → shouldContinueWithFlow: false.` : `
NO hay flujo de reserva activo.
shouldContinueWithFlow DEBE ser false.
Si pide turno/cita → action: "reservar".`;
  const systemPrompt = `Sos el asistente virtual de una clínica de quiropraxia y masajes en Argentina (2026).
Tu rol es ENTENDER el mensaje, responder con calidez y CLASIFICAR la intención correctamente.

⚠️ REGLA MÁS IMPORTANTE: NO hagas preguntas sobre fecha, hora, profesional ni servicio en responseText.
El sistema tiene botones y menús para eso. Solo respondé brevemente y clasificá.

Si hay un FLUJO ACTIVO y el usuario pregunta algo (ej. "por qué querés saber"), respondé la duda en responseText con action "consulta". El sistema mantiene el flujo; NO inventes menús.

El servicio se llama "Sesión de Quiropraxia" (NO "Quiropráctica").

${clinicContext}

REGLAS DE CLASIFICACIÓN:
- Usuario quiere reservar un turno (aunque sea conversacional) → action: "reservar"
- Usuario responde al paso actual del flujo de reserva → action: "reservar", shouldContinueWithFlow: true
- Usuario pide ver servicios, precios, sesiones o "mostrame los servicios" → action: "servicios" (NUNCA "consulta")
- Usuario solo pregunta algo sin intención de reservar ni ver catálogo → action: "consulta"
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
  const localIntent = parseLocalIntent(text);
  const hasAIResponse = Boolean(aiResult.responseText?.trim());
  const hasActiveFlow = Boolean(estado?.paso);

  // Sin flujo activo, NUNCA continuar flujo — evita saltar el inicio de reserva
  if (!hasActiveFlow) {
    aiResult.shouldContinueWithFlow = false;
  }

  // La UX de navegación la manda el intent local: la IA puede equivocarse en el action
  // y dejar botones genéricos cuando el usuario pidió servicios / reservar.
  const navActions = new Set(['servicios', 'reservar', 'misreservas', 'profesionales', 'menu']);
  if (localIntent && navActions.has(localIntent.action)) {
    const aiAction = aiResult.intent?.action || 'unknown';
    const shouldOverride =
      aiAction === 'unknown' ||
      aiAction === 'consulta' ||
      localIntent.action === 'servicios' ||
      localIntent.action === 'misreservas' ||
      localIntent.action === 'profesionales' ||
      localIntent.action === 'menu' ||
      (localIntent.action === 'reservar' && aiAction !== 'reservar');

    if (shouldOverride || localIntent.action === 'reservar') {
      return {
        responseText: aiResult.responseText || '',
        intent: {
          action: localIntent.action,
          parameters: {
            ...localIntent.parameters,
            ...aiResult.intent?.parameters,
          },
        },
        // Solo continuar flujo si hay paso activo de verdad
        shouldContinueWithFlow: Boolean(
          hasActiveFlow && aiResult.shouldContinueWithFlow && localIntent.action === 'reservar'
        ),
      };
    }
  }

  if (aiResult.intent?.action !== 'unknown' || hasAIResponse) {
    return {
      ...aiResult,
      shouldContinueWithFlow: Boolean(hasActiveFlow && aiResult.shouldContinueWithFlow),
    };
  }

  if (localIntent) {
    return { responseText: '', intent: localIntent, shouldContinueWithFlow: false };
  }

  return aiResult;
}

async function buildMisReservasKeyboard(reservasArray: Reservation[]) {
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  const now = Date.now();

  const futuras = reservasArray.filter(r => {
    const at = new Date(`${r.fecha}T${r.hora}:00`).getTime();
    return at >= now - 60 * 60 * 1000; // incluir hasta 1h después por tolerancia
  });

  for (const reservation of futuras) {
    const shortName = reservation.profesional.split(' ')[0];
    const label = `${formatDateShortSafe(reservation.fecha)} · ${reservation.hora} · ${reservation.servicio}`;
    keyboard.push([
      { text: label.length > 60 ? label.slice(0, 57) + '…' : label, callback_data: `ver_reserva:${reservation.id}` }
    ]);
    keyboard.push([
      { text: `🔄 Cambiar (${shortName})`, callback_data: `reprogramar:${reservation.id}` },
      { text: '❌ Cancelar', callback_data: `confirmar_eliminar:${reservation.id}` }
    ]);
  }

  keyboard.push([BTN.MENU]);
  return { keyboard, futuras, pastCount: reservasArray.length - futuras.length };
}

function formatDateShortSafe(fechaStr: string): string {
  const fecha = new Date(fechaStr + 'T12:00:00');
  const weekday = fecha.toLocaleDateString('es-AR', { weekday: 'short' });
  const day = fecha.getDate();
  const month = fecha.toLocaleDateString('es-AR', { month: 'short' });
  return `${weekday.charAt(0).toUpperCase() + weekday.slice(1)} ${day} ${month.charAt(0).toUpperCase() + month.slice(1)}`;
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
        await sendWithKeyboard(WELCOME_MESSAGE, MAIN_MENU_KEYBOARD);

      } else if (data === 'profesionales') {
        await sendWithKeyboard(
          '👨‍⚕️ *Nuestros profesionales*\n\n*(Atención particular, sin obra social)*\n\nTocá uno para reservar, o elegí al azar:',
          await buildProfesionalesKeyboard()
        );
      } else if (data === 'servicios') {
        const servicios = await getServiciosList();
        const list = servicios
          .map(s => `• *${s.nombre}* — ${formatPriceAR(s.precio)} (${s.duracionMinutos} min)`)
          .join('\n');
        await sendWithKeyboard(
          `🩺 *Servicios disponibles*\n\n*(Atención particular, sin obra social)*\n\n${list}\n\nTocá uno para reservarlo:`,
          await buildServiciosKeyboard(false)
        );

      } else if (data === 'reservar') {
        const limitReached = await checkReservationLimit(chatId);
        if (limitReached) {
          await sendWithKeyboard(
            '⚠️ *Límite de reservas alcanzado*\n\nYa tenés el máximo de turnos activos permitidos. Para reservar uno nuevo, primero tenés que cancelar alguno desde tus reservas.',
            [[{ text: '📋 Mis reservas', callback_data: 'misreservas' }], [{ text: '🏠 Menú', callback_data: 'menu' }]]
          );
        } else {
          // Misma UX que por texto: primero servicio, después profesional
          await saveState({ paso: 'servicio' });
          const servicios = await getServiciosList();
          const list = servicios
            .map(s => `• *${s.nombre}* — ${formatPriceAR(s.precio)} (${s.duracionMinutos} min)`)
            .join('\n');
          await sendWithKeyboard(
            `🩺 *Servicios disponibles*\n\n*(Atención particular, sin obra social)*\n\n${list}\n\nTocá uno para reservarlo:`,
            await buildServiciosKeyboard(false)
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
              [BTN.MENU]
            ]
          );
        } else {
          const { keyboard, futuras, pastCount } = await buildMisReservasKeyboard(reservasArray);
          if (futuras.length === 0) {
            await sendWithKeyboard(
              pastCount > 0
                ? 'No tenés turnos próximos. ¿Querés reservar uno nuevo?'
                : 'Todavía no tenés reservas. ¿Querés hacer una?',
              [[BTN.RESERVAR], [BTN.MENU]]
            );
          } else {
            await sendWithKeyboard(
              `📋 *Tus turnos*\n\nTocá *Cambiar* o *Cancelar* en cada uno.${pastCount > 0 ? `\n_(${pastCount} turno${pastCount > 1 ? 's' : ''} pasado${pastCount > 1 ? 's' : ''} oculto${pastCount > 1 ? 's' : ''})_` : ''}`,
              keyboard
            );
          }
        }

      } else if (data.startsWith('ver_reserva:')) {
        const reservaId = data.replace('ver_reserva:', '');
        const reserva = await getReservaById(chatId, reservaId);
        if (!reserva) {
          await sendWithKeyboard('No encontré esa reserva.', [[BTN.MIS_RESERVAS], [BTN.MENU]]);
        } else {
          const serv = await getServicio(reserva.servicio);
          await sendWithKeyboard(
            `📌 *Detalle del turno*\n\n` +
              buildBookingCard({
                profesional: reserva.profesional,
                servicio: reserva.servicio,
                nombre: reserva.nombre,
                fecha: reserva.fecha,
                hora: reserva.hora,
                duracionMinutos: serv?.duracionMinutos,
                precio: serv?.precio,
                codigo: shortBookingCode(reserva.id),
                includeDisclaimer: true,
              }),
            [
              [
                { text: '🔄 Cambiar', callback_data: `reprogramar:${reserva.id}` },
                { text: '❌ Cancelar turno', callback_data: `confirmar_eliminar:${reserva.id}` }
              ],
              [BTN.MIS_RESERVAS],
              [BTN.MENU]
            ]
          );
        }

      } else if (data.startsWith('reprogramar:')) {
        const reservaId = data.replace('reprogramar:', '');
        const reserva = await getReservaById(chatId, reservaId);

        if (!reserva) {
          await sendWithKeyboard('No encontré esa reserva.', [[BTN.MENU]]);
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
          await sendWithKeyboard(`🔄 *Cambiar turno*\n\n${view.text}`, view.keyboard);
        }

      } else if (data.startsWith('confirmar_eliminar:')) {
        const reservaId = data.replace('confirmar_eliminar:', '');
        const reserva = await getReservaById(chatId, reservaId);
        if (!reserva) {
          await sendWithKeyboard('No encontré esa reserva.', [[BTN.MIS_RESERVAS], [BTN.MENU]]);
        } else {
          await sendWithKeyboard(
            `⚠️ *¿Cancelar este turno?*\n\n` +
              `👨‍⚕️ ${reserva.profesional}\n` +
              `🩺 ${reserva.servicio}\n` +
              `📅 ${formatDate(reserva.fecha)} · ${reserva.hora}\n\n` +
              `Esta acción no se puede deshacer.`,
            [
              [{ text: '✅ Sí, cancelar turno', callback_data: `eliminar:${reservaId}` }],
              [{ text: '↩️ Volver', callback_data: 'misreservas' }]
            ]
          );
        }

      } else if (data.startsWith('eliminar:')) {
        const reservaId = data.replace('eliminar:', '');
        const reservaAntes = await getReservaById(chatId, reservaId);
        const eliminado = await eliminarReserva(chatId, reservaId);

        if (eliminado) {
          await sendWithKeyboard(
            reservaAntes
              ? `✅ Turno cancelado\n\n📅 ${formatDate(reservaAntes.fecha)} · ${reservaAntes.hora}\n🩺 ${reservaAntes.servicio} con ${reservaAntes.profesional}`
              : '✅ Reserva eliminada correctamente.',
            [
              [BTN.MIS_RESERVAS],
              [BTN.MENU]
            ]
          );
        } else {
          await sendWithKeyboard(
            'No se pudo eliminar la reserva.',
            [[BTN.MENU]]
          );
        }

      } else if (data === 'usar_nombre') {
        if (!estado.nombre || !estado.servicio || !estado.profesional) {
          await sendWithKeyboard('Sigamos desde el principio:', await buildProfesionalesKeyboard());
        } else {
          await saveState({ ...estado, paso: 'fecha' });
          const view = await buildFechasView(estado.servicio, estado.profesional);
          await sendWithKeyboard(`Perfecto, *${estado.nombre}* 👋\n\n${view.text}`, view.keyboard);
        }

      } else if (data === 'cambiar_nombre') {
        await saveState({ ...estado, paso: 'nombre', nombre: undefined });
        await sendWithKeyboard(
          withFlowProgress('nombre', 'Dale, ¿cuál es tu nombre?'),
          FLOW_CANCEL_KEYBOARD
        );

      } else if (data === 'aleatorio_profesional') {
        const profesionales = await getProfesionales();
        const profSeleccionado = profesionales[Math.floor(Math.random() * profesionales.length)];
        await continueAfterProfessional(
          chatId,
          estado,
          profSeleccionado,
          saveState,
          sendWithKeyboard,
          `🎲 Te tocó *${profSeleccionado}* ✔️\n\n`
        );

      } else if (data === 'aleatorio_servicio') {
        const servicios = await getServiciosList();
        const serv = servicios[Math.floor(Math.random() * servicios.length)];
        const servicioSeleccionado = serv.nombre;
        // Reusar el mismo handler que servicio_idx
        const fakeData = `servicio_idx:${servicios.findIndex(s => s.nombre === servicioSeleccionado)}`;
        // inline continue below via shared path — set and fall through by reassignment
        const profile = await getUserProfile(chatId, kv);
        const nombreGuardado = estado.nombre || profile?.nombre;

        if (!estado.profesional) {
          await saveState({ ...estado, paso: 'profesional', servicio: servicioSeleccionado });
          await sendWithKeyboard(
            `🎲 Te tocó *${servicioSeleccionado}* ✔️\n\n¿Con qué profesional te querés atender?`,
            await buildProfesionalesKeyboard()
          );
        } else if (nombreGuardado && estado.fecha) {
          await saveState({ ...estado, paso: 'hora', servicio: servicioSeleccionado, nombre: nombreGuardado });
          const view = await buildHorariosView(estado.fecha, servicioSeleccionado, estado.profesional!, estado.rescheduleId);
          await sendWithKeyboard(`🎲 Te tocó *${servicioSeleccionado}*\n\n${view.text}`, view.keyboard);
        } else if (nombreGuardado) {
          await saveState({ ...estado, paso: 'fecha', servicio: servicioSeleccionado, nombre: nombreGuardado });
          const view = await buildFechasView(servicioSeleccionado, estado.profesional);
          await sendWithKeyboard(
            `🎲 Te tocó *${servicioSeleccionado}*\n\nHola *${nombreGuardado}* 👋\n\n${view.text}`,
            view.keyboard
          );
        } else {
          const step = await buildNombreStep(
            { ...estado, servicio: servicioSeleccionado },
            chatId,
            `🎲 Te tocó *${servicioSeleccionado}* ✔️\n\n`
          );
          await saveState(step.estado);
          await sendWithKeyboard(step.text, step.keyboard);
        }

      } else if (data.startsWith('profesional:')) {
        const profSeleccionado = data.replace('profesional:', '');
        await continueAfterProfessional(
          chatId,
          estado,
          profSeleccionado,
          saveState,
          sendWithKeyboard,
          `*${profSeleccionado}* ✔️\n\n`
        );

      } else if (
        data.startsWith('reservar_servicio:') ||
        data.startsWith('servicio:') ||
        data.startsWith('servicio_idx:') ||
        data.startsWith('rsvc_idx:')
      ) {
        const servicioSeleccionado = await resolveServicioFromCallback(data);
        if (!servicioSeleccionado) {
          await sendWithKeyboard('No pude reconocer ese servicio. Probá de nuevo:', await buildServiciosKeyboard(true));
        } else if (!estado.profesional) {
          const limitReached = await checkReservationLimit(chatId);
          if (limitReached && !estado.paso) {
            await sendWithKeyboard(
              '⚠️ *Límite de reservas alcanzado*\n\nYa tenés el máximo de turnos activos. Cancelá uno desde Mis reservas.',
              [[BTN.MIS_RESERVAS], [BTN.MENU]]
            );
          } else {
            // Servicio primero → pedir profesional (servicio SIEMPRE queda guardado)
            await saveState({
              ...estado,
              paso: 'profesional',
              servicio: servicioSeleccionado,
              profesional: undefined,
            });
            await sendWithKeyboard(
              withFlowProgress(
                'profesional',
                `*${servicioSeleccionado}* ✔️\n\n¿Con qué profesional te querés atender?`
              ),
              await buildProfesionalesKeyboard()
            );
          }
        } else if ((estado.nombre || estado.rescheduleId) && estado.fecha) {
          await saveState({ ...estado, paso: 'hora', servicio: servicioSeleccionado });
          const view = await buildHorariosView(
            estado.fecha,
            servicioSeleccionado,
            estado.profesional,
            estado.rescheduleId
          );
          await sendWithKeyboard(view.text, view.keyboard);
        } else if (estado.nombre || estado.rescheduleId) {
          await saveState({ ...estado, paso: 'fecha', servicio: servicioSeleccionado });
          const view = await buildFechasView(servicioSeleccionado, estado.profesional);
          await sendWithKeyboard(`Hola *${estado.nombre}* 👋\n\n${view.text}`, view.keyboard);
        } else {
          const step = await buildNombreStep(
            { ...estado, servicio: servicioSeleccionado },
            chatId,
            `*${servicioSeleccionado}* ✔️\n\n`
          );
          await saveState(step.estado);
          await sendWithKeyboard(step.text, step.keyboard);
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
              const serv = await getServicio(reserva.servicio);
              await sendWithKeyboard(
                buildSuccessMessage(reserva, serv, true),
                POST_BOOKING_KEYBOARD
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
            const serv = await getServicio(reserva.servicio);
            await sendWithKeyboard(
              buildSuccessMessage(reserva, serv, false),
              POST_BOOKING_KEYBOARD
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

      const showMainMenu = async () => {
        // Siempre el mismo saludo: /start, Hola y Menú tienen que verse idénticos
        await sendWithKeyboard(WELCOME_MESSAGE, MAIN_MENU_KEYBOARD);
      };

      const showInfoResponse = async (infoType: 'obra_social' | 'horarios' | 'precios' | 'ubicacion') => {
        if (infoType === 'obra_social') {
          await sendWithKeyboard(
            '🏥 *Obra social*\n\nEn este momento *no recibimos obra social*. La atención es *particular*.\n\nSi querés, puedo mostrarte servicios, horarios o ayudarte a reservar un turno.',
            ASSIST_KEYBOARD
          );
        } else if (infoType === 'horarios') {
          await sendWithKeyboard(await buildHorariosInfoMessage(), ASSIST_KEYBOARD);
        } else if (infoType === 'ubicacion') {
          await sendWithKeyboard(buildLocationMessage(), ASSIST_KEYBOARD);
        } else {
          // Precios = catálogo accionable: el usuario toca el servicio que quiere
          await sendWithKeyboard(
            (await buildPreciosInfoMessage()) + '\n\nTocá un servicio para reservarlo:',
            await buildServiciosKeyboard(false)
          );
        }
      };

      const showProfesionalesCatalog = async (mode: 'info' | 'booking' = 'info') => {
        const profesionales = await getProfesionales();

        if (mode === 'info') {
          // Solo información: no empujar a reservar
          const list = profesionales.map(p => `• *${p}*`).join('\n');
          await sendWithKeyboard(
            `👨‍⚕️ *Nuestros profesionales*\n\n${list}\n\n*(Atención particular, sin obra social)*`,
            ASSIST_KEYBOARD
          );
          return;
        }

        await sendWithKeyboard(
          '👨‍⚕️ *Nuestros profesionales*\n\n*(Atención particular, sin obra social)*\n\nTocá uno para reservar, o elegí al azar:',
          await buildProfesionalesKeyboard()
        );
      };

      const isProfessionalsQuestion = (msg: string) => {
        const n = normalizeHumanText(msg);
        return (
          looksLikeQuestion(msg) ||
          n.includes('quien') ||
          n.includes('quienes') ||
          n.includes('que doctor') ||
          n.includes('que profesional') ||
          n.includes('que medico') ||
          n.includes('atienden') ||
          n.includes('atiende')
        );
      };

      const showServiciosCatalog = async (intro?: string) => {
        const servicios = await getServiciosList();
        const list = servicios
          .map(s => `• *${s.nombre}* — ${formatPriceAR(s.precio)} (${s.duracionMinutos} min)`)
          .join('\n');
        // Nunca mezclar intro de la IA (puede hablar de doctores): catálogo fijo
        const header =
          intro && /servicio|sesi[oó]n|precio|quiropraxia|masaje|premium/i.test(intro)
            ? intro.trim()
            : '🩺 *Servicios disponibles*\n\n*(Atención particular, sin obra social)*';
        await sendWithKeyboard(
          `${header}\n\n${list}\n\nTocá uno para reservarlo:`,
          await buildServiciosKeyboard(false)
        );
      };

      const showHorarios = async (fechaStr: string, servicio: string, profesional: string) => {
        await saveState({ ...estado, paso: 'hora', servicio, nombre: estado.nombre, fecha: fechaStr, profesional });
        const view = await buildHorariosView(fechaStr, servicio, profesional, estado.rescheduleId);
        await sendWithKeyboard(view.text, view.keyboard);
      };

      // Respuestas fijas (sin IA): menú, info y catálogos → siempre el mismo formato
      const quickLocal = parseLocalIntent(text);
      if (!estado?.paso) {
        if (quickLocal?.action === 'menu') {
          await clearState();
          await showMainMenu();
          return NextResponse.json({ status: 'ok' });
        }

        if (quickLocal?.action === 'profesionales') {
          await clearState();
          await showProfesionalesCatalog(isProfessionalsQuestion(text) ? 'info' : 'booking');
          return NextResponse.json({ status: 'ok' });
        }

        if (quickLocal?.action === 'servicios') {
          await clearState();
          await showServiciosCatalog();
          return NextResponse.json({ status: 'ok' });
        }

        const infoQuery = parseInfoQuery(text);
        if (infoQuery) {
          await clearState();
          await showInfoResponse(infoQuery);
          return NextResponse.json({ status: 'ok' });
        }
      }

      let aiResult = await resolveTextIntent(text, estado, chatId);

      if (aiResult.intent.action === 'consulta') {
        // Si hay un flujo activo, NO lo interrumpas: respondé y mantené el contexto
        if (estado?.paso) {
          const contextKeyboard = await getContextualKeyboard(estado);
          const answer = aiResult.responseText?.trim()
            || 'Dale, te cuento: es para dejar la reserva a tu nombre.';
          const nudge =
            estado.paso === 'nombre'
              ? '\n\nCuando puedas, escribí tu nombre para seguir.'
              : '\n\nSeguimos con la reserva cuando quieras.';
          await sendWithKeyboard(answer + nudge, contextKeyboard);
        } else {
          await clearState();
          const consultaInfo = parseInfoQuery(text);
          const responseText = aiResult.responseText?.trim() || '';
          const mentionsLocation =
            /monteagudo|tucum[aá]n|ubicaci[oó]n|direcci[oó]n|mapa|d[oó]nde estamos/i.test(responseText);
          const mentionsProfessionals =
            /profesional|doctor|francisco|javier|chibilisco|martoni/i.test(responseText) &&
            !/quiropraxia|masaje relajante|sesi[oó]n premium|\$\s*\d/i.test(responseText);
          const mentionsServices =
            /quiropraxia|masaje relajante|sesi[oó]n premium|precio/i.test(responseText);

          // Info fija siempre gana a la prosa de la IA
          if (consultaInfo === 'ubicacion' || mentionsLocation) {
            await showInfoResponse('ubicacion');
          } else if (mentionsProfessionals) {
            await showProfesionalesCatalog('info');
          } else if (consultaInfo === 'precios' || mentionsServices) {
            await showServiciosCatalog();
          } else if (consultaInfo) {
            await showInfoResponse(consultaInfo);
          } else if (responseText) {
            await sendWithKeyboard(responseText, ASSIST_KEYBOARD);
          } else {
            await sendWithKeyboard(
              'Con gusto te ayudo. Por el momento la atención es *particular* y *no recibimos obra social*.\n\nPodés consultar horarios, servicios o reservar un turno.',
              ASSIST_KEYBOARD
            );
          }
        }
      } else if (
        aiResult.intent.action !== 'unknown' &&
        !(aiResult.shouldContinueWithFlow && estado?.paso)
      ) {
        if (aiResult.intent.action === 'menu') {
          await clearState();
          await showMainMenu();
        } else if (aiResult.intent.action === 'servicios') {
          await showServiciosCatalog();
        } else if (aiResult.intent.action === 'profesionales') {
          await showProfesionalesCatalog(isProfessionalsQuestion(text) ? 'info' : 'booking');
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
                [BTN.MENU]
              ]
            );
          } else {
            const { keyboard, futuras, pastCount } = await buildMisReservasKeyboard(reservasArray);
            if (futuras.length === 0) {
              await sendWithKeyboard(
                'No tenés turnos próximos. ¿Querés reservar uno nuevo?',
                [[BTN.RESERVAR], [BTN.MENU]]
              );
            } else {
              await sendWithKeyboard(
                `📋 *Tus turnos*\n\nTocá *Cambiar* o *Cancelar* en cada uno.${pastCount > 0 ? `\n_(${pastCount} pasados ocultos)_` : ''}`,
                keyboard
              );
            }
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
            
            // Al pedir turno: siempre botones de servicio (no menú genérico)
            if (newEstado.paso === 'profesional' || newEstado.paso === 'servicio') {
              if (newEstado.profesional && newEstado.paso === 'servicio') {
                await sendWithKeyboard(
                  withFlowProgress(
                    'servicio',
                    aiResult.responseText?.trim() ||
                      `*${newEstado.profesional}* ✔️\n\n¿Qué servicio querés reservar?`
                  ),
                  await buildServiciosKeyboard(true)
                );
              } else {
                await saveState({ ...newEstado, paso: 'servicio', profesional: newEstado.profesional });
                await showServiciosCatalog(
                  '¡Dale! Elegí el tipo de sesión y te armo el turno:'
                );
              }
            } else if (newEstado.paso === 'nombre') {
              const step = await buildNombreStep(newEstado, chatId, `*${newEstado.servicio}* ✔️\n\n`);
              await saveState(step.estado);
              await sendWithKeyboard(step.text, step.keyboard);
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
          const normalized = normalizeHumanText(text);
          let profSeleccionado: string | null | undefined = null;

          if (['al azar', 'aleatorio', 'cualquiera', 'da igual', 'me da igual'].some(w => normalized.includes(w))) {
            profSeleccionado = profesionales[Math.floor(Math.random() * profesionales.length)];
          } else {
            const num = parseInt(text);
            if (!isNaN(num) && num >= 1 && num <= profesionales.length) {
              profSeleccionado = profesionales[num - 1];
            } else {
              profSeleccionado = profesionales.find(p => matchesLoosely(p, text)) ?? null;
            }
          }

          if (profSeleccionado) {
            if (estado.servicio) {
              const profile = await getUserProfile(chatId, kv);
              const nombreGuardado = estado.nombre || profile?.nombre;
              if (nombreGuardado) {
                await saveState({ ...estado, paso: 'fecha', profesional: profSeleccionado, nombre: nombreGuardado });
                const view = await buildFechasView(estado.servicio, profSeleccionado);
                await sendWithKeyboard(`*${profSeleccionado}* ✔️\n\nHola *${nombreGuardado}* 👋\n\n${view.text}`, view.keyboard);
              } else {
                await saveState({ ...estado, paso: 'nombre', profesional: profSeleccionado });
                await sendWithKeyboard(`*${profSeleccionado}* ✔️\n\n¿Cuál es tu nombre?`, FLOW_CANCEL_KEYBOARD);
              }
            } else {
              await saveState({ ...estado, paso: 'servicio', profesional: profSeleccionado });
              await sendWithKeyboard(
                `*${profSeleccionado}* ✔️\n\n¿Qué servicio querés reservar?`,
                await buildServiciosKeyboard(true)
              );
            }
          } else {
            await sendWithKeyboard('Elegí un profesional válido:', await buildProfesionalesKeyboard());
          }
        } else if (estado.paso === 'servicio') {
          const servicios = await getServiciosList();
          const normalized = normalizeHumanText(text);
          let servicioSeleccionado: string | null | undefined = null;

          if (['al azar', 'aleatorio', 'cualquiera', 'da igual', 'me da igual'].some(w => normalized.includes(w))) {
            servicioSeleccionado = servicios[Math.floor(Math.random() * servicios.length)].nombre;
          } else {
            const num = parseInt(text);
            if (!isNaN(num) && num >= 1 && num <= servicios.length) {
              servicioSeleccionado = servicios[num - 1].nombre;
            } else {
              servicioSeleccionado = servicios.find(s => matchesLoosely(s.nombre, text))?.nombre ?? null;
            }
          }

          if (servicioSeleccionado) {
            const profile = await getUserProfile(chatId, kv);
            const nombreGuardado = estado.nombre || profile?.nombre;
            if (nombreGuardado) {
              await saveState({ ...estado, paso: 'fecha', servicio: servicioSeleccionado, nombre: nombreGuardado });
              const view = await buildFechasView(servicioSeleccionado, estado.profesional);
              await sendWithKeyboard(`Hola *${nombreGuardado}* 👋\n\n${view.text}`, view.keyboard);
            } else {
              await saveState({ ...estado, paso: 'nombre', servicio: servicioSeleccionado });
              await sendWithKeyboard(`*${servicioSeleccionado}* ✔️\n\n¿Cuál es tu nombre?`, FLOW_CANCEL_KEYBOARD);
            }
          } else {
            await sendWithKeyboard(
              'No reconozco ese servicio. Por favor elegí uno:',
              await buildServiciosKeyboard(true)
            );
          }

        } else if (estado.paso === 'nombre') {
          if (!isValidPersonName(text)) {
            await sendWithKeyboard(
              withFlowProgress(
                'nombre',
                'Necesito tu nombre real para la reserva (sin números ni frases). Por ejemplo: *María López*.'
              ),
              FLOW_CANCEL_KEYBOARD
            );
          } else {
            const nombre = capitalizeName(text);
            await saveState({ ...estado, paso: 'fecha', nombre });
            await saveUserProfile(chatId, nombre, kv);
            const view = await buildFechasView(estado.servicio, estado.profesional);
            await sendWithKeyboard(`Hola *${nombre}* 👋\n\n${view.text}`, view.keyboard);
          }

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
              const period = wantsMorning ? 'la mañana (antes de las 13)' : 'la tarde (desde las 13)';
              await sendWithKeyboard(
                withFlowProgress('hora', `⏰ Turnos disponibles por ${period}:`),
                keyboard
              );
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
                  const serv = await getServicio(reserva.servicio);
                  await sendWithKeyboard(
                    buildSuccessMessage(reserva, serv, true),
                    POST_BOOKING_KEYBOARD
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
                  const serv = await getServicio(reserva.servicio);
                  await sendWithKeyboard(
                    buildSuccessMessage(reserva, serv, false),
                    POST_BOOKING_KEYBOARD
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
        } else if (containsBookingIntent(text) || /turno|cita|reserv/i.test(aiResult.responseText)) {
          // Pedido de turno mal clasificado → arrancar con servicios, nunca menú genérico
          await saveState({ paso: 'servicio' });
          await showServiciosCatalog(
            '¡Dale! Elegí el tipo de sesión y te armo el turno:'
          );
        } else {
          await clearState();
          await sendWithKeyboard(aiResult.responseText, ASSIST_KEYBOARD);
        }
      } else if (estado?.paso) {
        // No cortar el flujo: el usuario se equivocó, lo guiamos de nuevo
        const contextKeyboard = await getContextualKeyboard(estado);
        await sendWithKeyboard(
          'No te entendí del todo 🙏 Seguimos con la reserva. Elegí una opción o respondé lo que te pedí:',
          contextKeyboard
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
