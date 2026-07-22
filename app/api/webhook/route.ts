import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import { createClient } from '@vercel/kv';
import { getLocalReservations, addLocalReservation } from '../admin/reservations/route';
import {
  buildAppointmentsToolResult,
  clearGeminiHistory,
  runAssistantTurn,
  type AppointmentsAction,
  type AssistantToolHandlers,
  type AssistantTurnResult,
  type ClinicInfoTopic,
} from '@/lib/assistant';
import {
  BotIntent,
  containsBookingIntent,
  extractBookingParameters,
  getMisReservasMode,
  isAbortBookingIntent,
  isExplicitMenuCommand,
  isGreetingOrChatReset,
  isMisReservasIntent,
  isClinicScheduleQuestion,
  isTimeUntilIntent,
  isValidFlowInput,
  extractPersonName,
  looksLikeAvailabilityQuestion,
  looksLikeQuestion,
  matchesLoosely,
  normalizeHumanText,
  parseInfoQuery,
  parseLocalIntent,
  sanitizePersonName,
  type InfoQueryType,
  type MisReservasMode,
} from '@/lib/bot-intent';
import {
  BTN,
  buildAvailabilityPatientMessage,
  buildBookingCard,
  buildFaqCancelacionMessage,
  buildFaqDuracionMessage,
  buildFaqEstacionamientoMessage,
  buildFaqPagoMessage,
  buildFaqQueTraerMessage,
  buildFeriadoMessage,
  buildLimitReachedMessage,
  buildRebookButton,
  buildSuccessMessage,
  buildTurnoStatusMessage,
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
import { extractHoraCandidates, looksLikeHoraInput, parseHoraSelection } from '@/lib/parse-hora';
import { addDays, dayOfWeekFromFechaStr, getNowMinutesInArgentina, getToday, getTodayStr, parseFecha, toDateStr } from '@/lib/parse-fecha';
import { notifyStaff } from '@/lib/staff-notify';
import type { ConversationState, Reservation, StatePatch } from '@/lib/types';
import { getUserProfile, saveUserProfile } from '@/lib/user-profile';
import { getWaitlistEntry, joinWaitlist, notifyWaitlistForDay } from '@/lib/waitlist';

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

function readDaySlots(
  schedule: ProfessionalSchedule | undefined,
  dia: number
): Array<{ inicio: string; fin: string }> | undefined {
  if (!schedule) return undefined;
  if (Object.prototype.hasOwnProperty.call(schedule, dia)) {
    const slots = schedule[dia];
    return Array.isArray(slots) ? slots : undefined;
  }
  const asStr = String(dia);
  if (Object.prototype.hasOwnProperty.call(schedule, asStr)) {
    const slots = (schedule as any)[asStr];
    return Array.isArray(slots) ? slots : undefined;
  }
  return undefined;
}

/** Merge día a día. Si en KV el día falta o está [], se usan los defaults. */
function mergeProfessionalSchedules(
  defaults: Config['profesionales'],
  stored?: Config['profesionales']
): Config['profesionales'] {
  const names = new Set([...Object.keys(defaults), ...Object.keys(stored || {})]);
  const merged: Config['profesionales'] = {};

  for (const name of names) {
    const base = defaults[name] || {};
    const overlay = stored?.[name];
    const daySchedule: ProfessionalSchedule = {};

    for (let dia = 0; dia <= 6; dia++) {
      const fromOverlay = readDaySlots(overlay, dia);
      const fromBase = readDaySlots(base, dia);

      if (fromOverlay && fromOverlay.length > 0) {
        daySchedule[dia] = fromOverlay;
      } else if (fromBase && fromBase.length > 0) {
        // KV vacío o ausente → default (evita “no atiende miércoles” por [] en KV)
        daySchedule[dia] = fromBase;
      } else if (fromOverlay) {
        // [] explícito solo si tampoco hay default
        daySchedule[dia] = fromOverlay;
      }
    }

    merged[name] = daySchedule;
  }

  return merged;
}

function sanitizeFeriados(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(f => String(f).trim().slice(0, 10))
    .filter(f => /^\d{4}-\d{2}-\d{2}$/.test(f));
}

async function getConfig(): Promise<Config> {
  let config: Config;
  let hadStored = false;
  let feriadosRaw: unknown = [];
  if (kv) {
    const stored = await kv.get(KV_CONFIG_KEY);
    if (stored) {
      hadStored = true;
      config = typeof stored === 'string' ? JSON.parse(stored) : stored;
      feriadosRaw = (config as Config).feriados;
    } else {
      config = DEFAULT_CONFIG;
      feriadosRaw = DEFAULT_CONFIG.feriados;
    }
  } else {
    const localConfig = (global as any)._localAppConfig;
    config = localConfig || DEFAULT_CONFIG;
    feriadosRaw = config.feriados;
  }

  const feriadosBefore = sanitizeFeriados(feriadosRaw);
  // 15/07/2026 no es feriado en AR; si quedó cargado por error en el admin, sacarlo
  const feriados = feriadosBefore.filter(f => f !== '2026-07-15');

  config = {
    ...DEFAULT_CONFIG,
    ...config,
    feriados,
    profesionales: mergeProfessionalSchedules(DEFAULT_CONFIG.profesionales, config.profesionales),
    servicios: config.servicios && config.servicios.length > 0 ? config.servicios : DEFAULT_CONFIG.servicios,
  };

  config.servicios = config.servicios.map(s => ({
    ...s,
    nombre: s.nombre.replace(/Quiropráctica/gi, 'Quiropraxia').replace(/quiropractica/gi, 'Quiropraxia'),
  }));

  if (kv && hadStored && feriados.length !== feriadosBefore.length) {
    try {
      await kv.set(
        KV_CONFIG_KEY,
        JSON.stringify({
          profesionales: config.profesionales,
          feriados: config.feriados,
          servicios: config.servicios,
        })
      );
      console.warn('[config] Feriado inválido 2026-07-15 eliminado de KV');
    } catch (e) {
      console.error('[config] No se pudo persistir limpieza de feriados:', e);
    }
  }

  return config;
}

async function isFeriado(fechaStr: string): Promise<boolean> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaStr)) return false;
  const config = await getConfig();
  return sanitizeFeriados(config.feriados).includes(fechaStr);
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
  let schedule = config.profesionales[profesional];
  if (!schedule) {
    const key = Object.keys(config.profesionales).find(p => matchesLoosely(p, profesional));
    if (key) schedule = config.profesionales[key];
  }

  const slots = readDaySlots(schedule, dia);
  if (slots && slots.length > 0) return slots;

  const defaultKey =
    DEFAULT_CONFIG.profesionales[profesional]
      ? profesional
      : Object.keys(DEFAULT_CONFIG.profesionales).find(p => matchesLoosely(p, profesional));
  const fallback = defaultKey ? readDaySlots(DEFAULT_CONFIG.profesionales[defaultKey], dia) : undefined;
  if (fallback && fallback.length > 0) return fallback;

  return slots || [];
}

async function esDiaLaborable(fechaStr: string, profesional?: string): Promise<boolean> {
  const esFeriadoFlag = await isFeriado(fechaStr);
  if (esFeriadoFlag) return false;
  
  if (!profesional) {
    const dia = dayOfWeekFromFechaStr(fechaStr);
    return dia >= 1 && dia <= 6;
  }
  
  const dia = dayOfWeekFromFechaStr(fechaStr);
  const horarios = await getHorarioProfesional(profesional, dia);
  return horarios.length > 0;
}

// Función para formatear fecha de forma legible
function formatDate(fechaStr: string): string {
  return formatDateAR(fechaStr);
}

/** Etiqueta corta de día en zona Argentina (evita desfasajes UTC en Vercel). */
function formatDayButtonShort(fechaStr: string): string {
  const [y, m, d] = fechaStr.split('-').map(Number);
  // 15:00 UTC = 12:00 en Argentina → el día de calendario no se corre
  const instant = new Date(Date.UTC(y, m - 1, d, 15, 0, 0));
  const weekday = new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    weekday: 'short',
  }).format(instant);
  const day = new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    day: 'numeric',
  }).format(instant);
  const month = new Intl.DateTimeFormat('es-AR', {
    timeZone: 'America/Argentina/Buenos_Aires',
    month: 'short',
  }).format(instant);
  const wd = weekday.replace('.', '').trim();
  const mo = month.replace('.', '').trim();
  return `${wd.charAt(0).toUpperCase() + wd.slice(1)} ${day} ${mo.charAt(0).toUpperCase() + mo.slice(1)}`;
}

async function proximosDiasLaborables(
  cantidad: number,
  profesional?: string,
  servicio?: string,
  excludeReservaId?: string
): Promise<{ fecha: string; label: string }[]> {
  const dias: { fecha: string; label: string }[] = [];
  const today = getToday();
  const todayStr = getTodayStr();
  const tomorrowStr = toDateStr(addDays(today, 1));
  let offset = 0;

  while (dias.length < cantidad && offset < 45) {
    const candidate = addDays(today, offset);
    const candidateFechaStr = toDateStr(candidate);
    const day = dayOfWeekFromFechaStr(candidateFechaStr);
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
      works = !esFeriadoFlag && day >= 1 && day <= 6;
    }

    if (works) {
      // Importante: NO filtrar por slots libres acá.
      // Si filtramos “hoy” por horarios ya pasados (o un desfase TZ),
      // desaparece el botón Hoy aunque el profesional atienda ese día.
      const short = formatDayButtonShort(candidateFechaStr);
      let label: string;
      if (candidateFechaStr === todayStr) {
        label = `Hoy · ${short}`;
      } else if (candidateFechaStr === tomorrowStr) {
        label = `Mañana · ${short}`;
      } else {
        label = short;
      }
      dias.push({ fecha: candidateFechaStr, label });
    }
    offset++;
  }
  return dias;
}

async function buildFechasKeyboard(
  profesional?: string,
  servicio?: string,
  excludeReservaId?: string
) {
  const dias = await proximosDiasLaborables(8, profesional, servicio, excludeReservaId);
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

async function buildFechasView(
  servicio?: string,
  profesional?: string,
  excludeReservaId?: string
) {
  const header = servicio
    ? `📅 *${servicio}*${profesional ? `\n👨‍⚕️ ${profesional}` : ''}\n\n¿Qué día preferís?`
    : '📅 ¿Qué día te gustaría?';
  return {
    text: withFlowProgress('fecha', header),
    keyboard: await buildFechasKeyboard(profesional, servicio, excludeReservaId)
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

async function loadConversationState(chatId: number): Promise<ConversationState> {
  const estadoKey = `conv:${chatId}`;
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
}

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
  if (!profesional || !servicioNombre) return libres;

  const dia = dayOfWeekFromFechaStr(fechaStr);
  const horarios = await getHorarioProfesional(profesional, dia);
  if (horarios.length === 0) return libres;
  
  const servicio = await getServicio(servicioNombre);
  if (!servicio) return libres;

  const todayStr = getTodayStr();
  const nowMinutes = fechaStr === todayStr ? getNowMinutesInArgentina() : -1;
  
  for (const horario of horarios) {
    const [hIni, mIni] = horario.inicio.split(':').map(Number);
    const [hFin, mFin] = horario.fin.split(':').map(Number);
    let minutosActuales = hIni * 60 + mIni;
    const minutosFin = hFin * 60 + mFin;
    
    while (minutosActuales + servicio.duracionMinutos <= minutosFin) {
      const hStr = Math.floor(minutosActuales / 60).toString().padStart(2, '0');
      const mStr = (minutosActuales % 60).toString().padStart(2, '0');
      const horaStr = `${hStr}:${mStr}`;

      // No ofrecer turnos que ya empezaron (margen 5 min de cortesía).
      // nowMinutes SIEMPRE es hora Argentina (UTC-3), nunca UTC del server.
      if (nowMinutes >= 0 && minutosActuales + 5 <= nowMinutes) {
        minutosActuales += servicio.duracionMinutos;
        continue;
      }
      
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

async function buildEmptyHorariosView(
  fechaStr: string,
  servicio: string,
  profesional: string,
  reason: 'no_atiende' | 'sin_restantes' | 'ocupado' | 'servicio',
  excludeReservaId?: string
) {
  const proximas = await proximosDiasLaborables(10, profesional, servicio, excludeReservaId);
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
  if (reason === 'ocupado' || reason === 'sin_restantes') {
    keyboard.push([
      { text: '🔔 Avisame si se libera', callback_data: `wl_join:${fechaStr}` },
    ]);
  }
  keyboard.push([BTN.MENU]);

  const fechaLabel = formatDate(fechaStr);
  let body: string;
  if (reason === 'no_atiende') {
    body =
      `📭 *${profesional}* no atiende el ${fechaLabel}.\n\n` +
      (siguientes.length
        ? 'Estas son las próximas fechas con turno:'
        : 'Probá con otra fecha o volvé al menú:');
  } else if (reason === 'sin_restantes') {
    body =
      `⏰ Para *${servicio}* el ${fechaLabel} con *${profesional}* ` +
      `ya no quedan horarios *de hoy* (los turnos de la mañana ya pasaron o están tomados).\n\n` +
      (siguientes.length
        ? 'Podés ver estas próximas fechas, o pedime que te avise si se libera algo:'
        : 'Pedime que te avise si se libera un turno, o volvé al menú:');
  } else if (reason === 'servicio') {
    body = `⚠️ No reconocí el servicio *${servicio}*. Elegí uno de la lista:`;
    return {
      text: withFlowProgress('hora', body),
      keyboard: await buildServiciosKeyboard(false),
    };
  } else {
    body =
      `😕 Ese día está *lleno* para *${servicio}* con *${profesional}* (${fechaLabel}).\n\n` +
      (siguientes.length
        ? 'Probá con una de estas fechas, o pedime que te avise si se libera un turno:'
        : 'Pedime que te avise si se libera un turno, o volvé al menú:');
  }

  return {
    text: withFlowProgress('hora', body),
    keyboard
  };
}

function filterHorariosByFranja(
  horarios: string[],
  franja?: 'manana' | 'tarde'
): string[] {
  if (!franja) return horarios;
  return horarios.filter(h => {
    const hour = parseInt(h.split(':')[0], 10);
    return franja === 'manana' ? hour < 13 : hour >= 13;
  });
}

async function buildHorariosView(
  fechaStr: string,
  servicio: string,
  profesional: string,
  excludeReservaId?: string,
  franja?: 'manana' | 'tarde'
) {
  if (!profesional || !servicio) {
    return {
      text: withFlowProgress(
        'hora',
        '⚠️ Me faltó un dato de la reserva. Empecemos de nuevo eligiendo el servicio:'
      ),
      keyboard: await buildServiciosKeyboard(false),
    };
  }

  const dia = dayOfWeekFromFechaStr(fechaStr);
  const agenda = await getHorarioProfesional(profesional, dia);
  const esFeriadoFlag = await isFeriado(fechaStr);
  if (esFeriadoFlag) {
    return {
      text: withFlowProgress('hora', buildFeriadoMessage(formatDate(fechaStr))),
      keyboard: [
        [{ text: '📅 Otra fecha', callback_data: 'cambiar_fecha' }],
        [BTN.MENU],
      ],
    };
  }
  if (agenda.length === 0) {
    return buildEmptyHorariosView(fechaStr, servicio, profesional, 'no_atiende', excludeReservaId);
  }

  const serv = await getServicio(servicio);
  if (!serv) {
    return buildEmptyHorariosView(fechaStr, servicio, profesional, 'servicio', excludeReservaId);
  }

  const todosLibres = await obtenerHorariosLibres(fechaStr, profesional, servicio, excludeReservaId);
  const horariosLibres = filterHorariosByFranja(todosLibres, franja);

  if (todosLibres.length === 0) {
    const reason =
      fechaStr === getTodayStr() ? 'sin_restantes' : 'ocupado';
    return buildEmptyHorariosView(fechaStr, servicio, profesional, reason, excludeReservaId);
  }

  if (horariosLibres.length === 0 && franja) {
    const period = franja === 'manana' ? 'la mañana' : 'la tarde';
    const keyboard: any[] = [];
    for (let i = 0; i < todosLibres.length; i += 3) {
      keyboard.push(
        todosLibres.slice(i, i + 3).map(h => ({ text: `🕐 ${h}`, callback_data: `hora:${h}` }))
      );
    }
    keyboard.push([
      { text: '📅 Cambiar fecha', callback_data: 'cambiar_fecha' },
      BTN.MENU,
    ]);
    return {
      text: withFlowProgress(
        'hora',
        `😕 No hay turnos por *${period}* el ${formatDate(fechaStr)}.\n\n` +
          `Estos son todos los horarios libres:`
      ),
      keyboard,
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

  const duracion = ` · ${serv.duracionMinutos} min`;
  const franjaHint =
    franja === 'manana'
      ? '\n_(Mostrando turnos de la mañana)_'
      : franja === 'tarde'
        ? '\n_(Mostrando turnos de la tarde)_'
        : '';
  return {
    text: withFlowProgress(
      'hora',
      `🗓 *${servicio}*${duracion}\n` +
        `👨‍⚕️ ${profesional}\n` +
        `📅 ${formatDate(fechaStr)}${franjaHint}\n\n` +
        `⏰ Elegí un horario:`
    ),
    keyboard
  };
}

/** Nombre del draft/perfil, o undefined si falta / es basura. */
async function resolvePatientNombre(
  chatId: number,
  estado: ConversationState,
  hint?: string
): Promise<string | undefined> {
  return (
    sanitizePersonName(hint) ||
    sanitizePersonName(estado.nombre) ||
    sanitizePersonName((await getUserProfile(chatId, kv))?.nombre)
  );
}

/**
 * Después de elegir hora: pedir nombre si falta; si no, ir a confirmar.
 * Evita reservar con nombre undefined.
 */
async function proceedAfterSlotChosen(
  chatId: number,
  estado: ConversationState,
  hora: string,
  saveState: (patch: StatePatch) => Promise<void>,
  sendWithKeyboard: (text: string, keyboard: any) => Promise<void>
) {
  const nombre = await resolvePatientNombre(chatId, estado);
  const base = { ...estado, hora };

  if (!nombre) {
    await saveState({
      ...base,
      paso: 'nombre',
      clear: ['nombre'],
    });
    await sendWithKeyboard(
      'Dale, ¿a nombre de quién reservo el turno?\n\nEscribí tu nombre (ej: *María López*).',
      FLOW_CANCEL_KEYBOARD
    );
    return;
  }

  await saveState({ ...base, paso: 'confirmar', nombre });
  const view = await buildConfirmacionView({ ...base, nombre });
  await sendWithKeyboard(view.text, view.keyboard);
}

type AvailabilityToolData = {
  fechaLabel?: string;
  feriado?: boolean;
  count?: number;
  needServiceChoice?: boolean;
  recommendation?: { hora: string; profesional: string; servicio: string };
  window?: { horaPreferida?: string | null };
  requestedHoraAvailable?: boolean | null;
};

function buildAvailabilityFallbackMessage(
  fechaHint: string | null,
  data: AvailabilityToolData
): string {
  if (!fechaHint) {
    return (
      'Dale, te ayudo con el turno.\n\n' +
      '¿Para qué día lo necesitás?\n' +
      'Podés escribir *mañana*, *el lunes* o tocar un día 👇'
    );
  }
  return buildAvailabilityPatientMessage({
    fechaLabel: data.fechaLabel || formatDateAR(fechaHint),
    needServiceChoice: data.needServiceChoice,
    empty: (data.count ?? 0) === 0,
    feriado: data.feriado,
    recommendation: data.recommendation,
    horaPedida: data.window?.horaPreferida ?? null,
    requestedHoraAvailable: data.requestedHoraAvailable ?? null,
  });
}

async function mergeDraftFromSideEffect(
  saveState: (patch: StatePatch) => Promise<void>,
  draft: ConversationState & { clear?: Array<keyof ConversationState> }
) {
  const extraClear = draft.clear?.length
    ? draft.clear
    : draft.paso === 'hora' || draft.paso === 'fecha'
      ? (['hora'] as Array<keyof ConversationState>)
      : [];
  await saveState({
    paso: draft.paso,
    ...(draft.profesional ? { profesional: draft.profesional } : {}),
    ...(draft.servicio ? { servicio: draft.servicio } : {}),
    ...(draft.nombre ? { nombre: draft.nombre } : {}),
    ...(draft.fecha ? { fecha: draft.fecha } : {}),
    ...(draft.hora ? { hora: draft.hora } : {}),
    ...(draft.rescheduleId ? { rescheduleId: draft.rescheduleId } : {}),
    ...(extraClear.length ? { clear: extraClear } : {}),
  });
}

/** Misma lógica para texto, fallback y botones (WhatsApp-ready). */
async function replyWithAvailabilityTool(
  chatId: number,
  opts: {
    fecha?: string;
    saveState: (patch: StatePatch) => Promise<void>;
    sendWithKeyboard: (text: string, keyboard?: any) => Promise<void>;
    handlers?: AssistantToolHandlers;
  }
) {
  const handlers = opts.handlers ?? makeAssistantHandlers(chatId);
  const tool = await handlers.getAvailability({ fecha: opts.fecha });
  if (tool.sideEffect?.type === 'set_draft') {
    await mergeDraftFromSideEffect(opts.saveState, tool.sideEffect.draft);
  }
  const data = (tool.data || {}) as AvailabilityToolData;
  await opts.sendWithKeyboard(
    buildAvailabilityFallbackMessage(opts.fecha ?? null, data),
    tool.keyboard && tool.keyboard.length > 0 ? tool.keyboard : ASSIST_KEYBOARD
  );
}

/** Aplica side effects del asistente y envía respuesta. true = turno procesado. */
async function dispatchAssistantTurnResult(
  chatId: number,
  result: AssistantTurnResult,
  ctx: {
    saveState: (patch: StatePatch) => Promise<void>;
    sendWithKeyboard: (text: string, keyboard?: any) => Promise<void>;
    clearState?: () => Promise<void>;
    draft?: ConversationState;
  }
): Promise<boolean> {
  if (!result.viaLlm) return false;

  const hasPayload =
    Boolean(result.text?.trim()) ||
    Boolean(result.keyboard?.length) ||
    Boolean(result.sideEffect) ||
    result.usedTools.length > 0;
  if (!hasPayload) return false;

  if (result.sideEffect?.type === 'start_reschedule') {
    const reserva = result.sideEffect.reserva;
    await ctx.saveState({
      paso: 'fecha',
      rescheduleId: reserva.id,
      profesional: reserva.profesional,
      servicio: reserva.servicio,
      nombre: reserva.nombre,
      fecha: reserva.fecha,
      hora: reserva.hora,
    });
    const view = await buildFechasView(reserva.servicio, reserva.profesional, reserva.id);
    await ctx.sendWithKeyboard(result.text?.trim() || 'Elegí la nueva fecha:', view.keyboard);
    return true;
  }

  if (result.sideEffect?.type === 'clear_draft') {
    if (ctx.clearState) await ctx.clearState();
    // Preferir prosa de Gemini; replyText solo si el modelo no escribió nada.
    const replyText =
      result.text?.trim() ||
      result.sideEffect.replyText?.trim() ||
      'Listo.';
    await ctx.sendWithKeyboard(
      replyText,
      result.keyboard && result.keyboard.length > 0 ? result.keyboard : POST_BOOKING_KEYBOARD
    );
    return true;
  }

  if (result.sideEffect?.type === 'confirm_cancel') {
    const reserva = result.sideEffect.reserva;
    await ctx.sendWithKeyboard(result.text?.trim() || '¿Confirmás la cancelación?', [
      [{ text: '✅ Sí, cancelar turno', callback_data: `eliminar:${reserva.id}` }],
      [{ text: '↩️ Volver', callback_data: 'misreservas' }],
    ]);
    return true;
  }

  if (result.sideEffect?.type === 'set_draft') {
    const draft = result.sideEffect.draft;
    await mergeDraftFromSideEffect(ctx.saveState, draft);

    // Gemini escribe el mensaje; el teclado viene de la tool (o vista solo como fallback).
    if (
      draft.paso === 'confirmar' &&
      draft.fecha &&
      draft.hora &&
      draft.profesional &&
      draft.servicio &&
      draft.nombre
    ) {
      const view = await buildConfirmacionView(draft);
      await ctx.sendWithKeyboard(
        result.text?.trim() || view.text,
        result.keyboard && result.keyboard.length > 0 ? result.keyboard : view.keyboard
      );
      return true;
    }

    if (draft.paso === 'nombre' && draft.hora && !draft.nombre) {
      await ctx.sendWithKeyboard(
        result.text?.trim() ||
          'Dale, ¿a nombre de quién reservo el turno?\n\nEscribí tu nombre (ej: *María López*).',
        result.keyboard && result.keyboard.length > 0 ? result.keyboard : FLOW_CANCEL_KEYBOARD
      );
      return true;
    }
  }

  const replyText =
    result.text?.trim() ||
    (result.keyboard?.length ? 'Perfecto, seguimos:' : '¿En qué más te ayudo?');

  let keyboard =
    result.keyboard && result.keyboard.length > 0 ? result.keyboard : null;
  if (!keyboard && ctx.draft?.paso) {
    keyboard = await getContextualKeyboard(ctx.draft);
  }
  await ctx.sendWithKeyboard(replyText, keyboard || ASSIST_KEYBOARD);
  return true;
}

function hasHeldBookingSlot(estado: ConversationState | null | undefined): boolean {
  return Boolean(
    estado?.hora &&
      estado?.fecha &&
      estado?.profesional &&
      estado?.servicio &&
      (estado.paso === 'confirmar' || estado.paso === 'nombre')
  );
}

async function handleFlowFechaInput(
  chatId: number,
  estado: ConversationState,
  text: string,
  ctx: {
    saveState: (patch: StatePatch) => Promise<void>;
    sendWithKeyboard: (text: string, keyboard?: any) => Promise<void>;
  }
): Promise<boolean> {
  const fechaParseada = parseFecha(text);
  if (!fechaParseada) return false;

  if (!estado.profesional || !estado.servicio) {
    await ctx.saveState({
      ...estado,
      paso: 'fecha',
      fecha: fechaParseada,
      clear: ['hora'],
    });
    await replyWithAvailabilityTool(chatId, {
      fecha: fechaParseada,
      saveState: ctx.saveState,
      sendWithKeyboard: ctx.sendWithKeyboard,
    });
    return true;
  }

  const esDiaValido = await esDiaLaborable(fechaParseada, estado.profesional);
  if (esDiaValido) {
    await ctx.saveState({
      paso: 'hora',
      servicio: estado.servicio,
      profesional: estado.profesional,
      nombre: estado.nombre,
      fecha: fechaParseada,
      rescheduleId: estado.rescheduleId,
      clear: ['hora'],
    });
    const view = await buildHorariosView(
      fechaParseada,
      estado.servicio,
      estado.profesional,
      estado.rescheduleId
    );
    await ctx.sendWithKeyboard(view.text, view.keyboard);
  } else {
    const keyboard = await buildFechasKeyboard(
      estado.profesional,
      estado.servicio,
      estado.rescheduleId
    );
    await ctx.sendWithKeyboard('❌ El profesional no atiende ese día. Elegí otro:', keyboard);
  }
  return true;
}

async function handleFlowNombreInput(
  chatId: number,
  estado: ConversationState,
  text: string,
  ctx: {
    saveState: (patch: StatePatch) => Promise<void>;
    sendWithKeyboard: (text: string, keyboard?: any) => Promise<void>;
  }
): Promise<boolean> {
  const extracted = extractPersonName(text);
  if (!extracted) {
    await ctx.sendWithKeyboard(
      withFlowProgress(
        'nombre',
        'Necesito tu nombre real para la reserva (sin números ni frases). Por ejemplo: *María López*.'
      ),
      FLOW_CANCEL_KEYBOARD
    );
    return true;
  }

  const nombre = capitalizeName(extracted);
  await saveUserProfile(chatId, nombre, kv);

  if (estado.fecha && estado.hora && estado.profesional && estado.servicio) {
    await ctx.saveState({ ...estado, paso: 'confirmar', nombre });
    const view = await buildConfirmacionView({ ...estado, nombre });
    await ctx.sendWithKeyboard(`Perfecto, *${nombre}* 👋\n\n${view.text}`, view.keyboard);
  } else {
    await ctx.saveState({ ...estado, paso: 'fecha', nombre });
    const view = await buildFechasView(estado.servicio, estado.profesional);
    await ctx.sendWithKeyboard(`Hola *${nombre}* 👋\n\n${view.text}`, view.keyboard);
  }
  return true;
}

async function handleFlowHoraInput(
  chatId: number,
  estado: ConversationState,
  text: string,
  ctx: {
    saveState: (patch: StatePatch) => Promise<void>;
    sendWithKeyboard: (text: string, keyboard?: any) => Promise<void>;
  }
): Promise<boolean> {
  if (!estado.fecha || !estado.profesional || !estado.servicio) return false;

  const fechaNueva = parseFecha(text);
  if (fechaNueva && fechaNueva !== estado.fecha) {
    const laborable = await esDiaLaborable(fechaNueva, estado.profesional);
    if (!laborable) {
      const keyboard = await buildFechasKeyboard(
        estado.profesional,
        estado.servicio,
        estado.rescheduleId
      );
      await ctx.sendWithKeyboard(
        `Ese día (*${formatDateAR(fechaNueva)}*) no hay agenda con *${estado.profesional}*. Elegí otra fecha:`,
        keyboard
      );
      return true;
    }
    await ctx.saveState({
      ...estado,
      paso: 'hora',
      fecha: fechaNueva,
      clear: ['hora'],
    });
    const view = await buildHorariosView(
      fechaNueva,
      estado.servicio,
      estado.profesional,
      estado.rescheduleId
    );
    await ctx.sendWithKeyboard(view.text, view.keyboard);
    return true;
  }

  const horariosLibres = await obtenerHorariosLibres(
    estado.fecha,
    estado.profesional,
    estado.servicio,
    estado.rescheduleId
  );

  const normalizedPeriod = normalizeHumanText(text);
  const morningPref =
    /por\s+la\s+manana|a\s+la\s+manana|de\s+manana|x\s+la\s+manana/.test(normalizedPeriod);
  const afternoonPref =
    /por\s+la\s+tarde|a\s+la\s+tarde|de\s+tarde|x\s+la\s+tarde/.test(normalizedPeriod);
  const wantsMorning = morningPref;
  const wantsAfternoon =
    afternoonPref ||
    (/\btarde\b/.test(normalizedPeriod) && !parseFecha(text) && !morningPref);
  const mentionsConcreteTime = extractHoraCandidates(text).length > 0;

  if ((wantsMorning || wantsAfternoon) && !mentionsConcreteTime) {
    const filtered = horariosLibres.filter(h => {
      const hour = parseInt(h.split(':')[0]);
      return wantsMorning ? hour < 13 : hour >= 13;
    });
    if (filtered.length > 0) {
      const keyboard: any[] = [];
      for (let i = 0; i < filtered.length; i += 3) {
        keyboard.push(
          filtered.slice(i, i + 3).map(h => ({ text: `🕐 ${h}`, callback_data: `hora:${h}` }))
        );
      }
      keyboard.push([
        { text: '📅 Ver todos', callback_data: 'refresh_horarios' },
        { text: '🏠 Menú', callback_data: 'menu' },
      ]);
      const period = wantsMorning ? 'la mañana (antes de las 13)' : 'la tarde (desde las 13)';
      await ctx.sendWithKeyboard(
        withFlowProgress('hora', `⏰ Turnos disponibles por ${period}:`),
        keyboard
      );
    } else {
      const period = wantsMorning ? 'la mañana' : 'la tarde';
      const view = await buildHorariosView(
        estado.fecha,
        estado.servicio,
        estado.profesional,
        estado.rescheduleId
      );
      await ctx.sendWithKeyboard(
        `😕 No hay turnos disponibles por ${period}. Todos los horarios disponibles:`,
        view.keyboard
      );
    }
    return true;
  }

  const parsedHora = parseHoraSelection(text, horariosLibres);

  if (parsedHora.status === 'ambiguous') {
    const keyboard: any[] = [];
    for (let i = 0; i < parsedHora.candidates.length; i += 3) {
      keyboard.push(
        parsedHora.candidates.slice(i, i + 3).map(h => ({
          text: `🕐 ${h}`,
          callback_data: `hora:${h}`,
        }))
      );
    }
    keyboard.push([{ text: '📅 Ver todos', callback_data: 'refresh_horarios' }, BTN.MENU]);
    await ctx.sendWithKeyboard(
      withFlowProgress(
        'hora',
        `Vi más de un horario (*${parsedHora.candidates.join('*, *')}*). ¿Cuál preferís?`
      ),
      keyboard
    );
    return true;
  }

  if (parsedHora.status === 'matched') {
    const rescheduleOptions = await getRescheduleOptions(chatId, estado.rescheduleId);
    const disponibilidad = await verificarDisponibilidad(
      estado.profesional,
      estado.servicio,
      estado.fecha,
      parsedHora.hora,
      rescheduleOptions
    );

    if (disponibilidad.disponible) {
      await proceedAfterSlotChosen(
        chatId,
        estado,
        parsedHora.hora,
        ctx.saveState,
        ctx.sendWithKeyboard
      );
    } else {
      const viewActualizada = await buildHorariosView(
        estado.fecha,
        estado.servicio,
        estado.profesional,
        estado.rescheduleId
      );
      await ctx.sendWithKeyboard(
        `⚠️ ${disponibilidad.mensaje || 'Ese horario no está disponible.'}\n\nElegí otro turno:`,
        viewActualizada.keyboard
      );
    }
    return true;
  }

  const view = await buildHorariosView(
    estado.fecha,
    estado.servicio,
    estado.profesional,
    estado.rescheduleId
  );
  await ctx.sendWithKeyboard(
    'No pude interpretar ese horario. Tocá uno de la lista o escribí por ejemplo *15:30*:',
    view.keyboard
  );
  return true;
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
    const dia = dayOfWeekFromFechaStr(fechaStr);

    const esFeriadoFlag = await isFeriado(fechaStr);
    if (esFeriadoFlag) {
      return { disponible: false, mensaje: buildFeriadoMessage(formatDate(fechaStr)) };
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

    const nombreOk = sanitizePersonName(datos.nombre);
    if (!nombreOk) {
      console.warn(`[RESERVA] nombre inválido o vacío: ${datos.nombre}`);
      return null;
    }

    const id = generateId();
    const reserva: Reservation = {
      ...datos,
      nombre: nombreOk,
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

    await saveUserProfile(
      chatId,
      {
        nombre: datos.nombre,
        lastProfesional: datos.profesional,
        lastServicio: datos.servicio,
      },
      kv
    );
    await notifyStaff('created', reserva);
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

    const previous = { fecha: reserva.fecha, hora: reserva.hora };

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

    // El día anterior quedó con un hueco → avisar lista de espera
    await pingWaitlist(reserva.profesional, reserva.fecha);

    await saveUserProfile(
      chatId,
      {
        nombre: updatedReservation.nombre,
        lastProfesional: updatedReservation.profesional,
        lastServicio: updatedReservation.servicio,
      },
      kv
    );

    await notifyStaff('rescheduled', updatedReservation, previous);

    return updatedReservation;
  } catch (error) {
    console.error('Error al reprogramar reserva:', error);
    return null;
  }
}

// Función para eliminar reserva
async function eliminarReserva(chatId: number, reservaId: string): Promise<Reservation | false> {
  try {
    let reservaEliminada: Reservation | null = null;

    if (kv) {
      const idKey = `reserva:id:${reservaId}`;
      const reservaData = await kv.get(idKey);
      if (!reservaData) return false;

      const reserva = typeof reservaData === 'string' ? JSON.parse(reservaData) : reservaData;

      if (reserva.chatId !== chatId) {
        console.warn(`[SEGURIDAD] Intento de eliminar reserva ajena: chatId ${chatId} vs ${reserva.chatId}`);
        return false;
      }

      reservaEliminada = reserva;
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
        reservaEliminada = localReservations[index];
        localReservations.splice(index, 1);
      } else {
        return false;
      }
    }

    if (reservaEliminada) {
      await notifyStaff('cancelled', reservaEliminada);
    }

    return reservaEliminada || false;
  } catch (error) {
    console.error('Error al eliminar reserva:', error);
    return false;
  }
}

async function pingWaitlist(profesional: string, fecha: string) {
  try {
    await notifyWaitlistForDay(profesional, fecha, (servicio) =>
      obtenerHorariosLibres(fecha, profesional, servicio)
    );
  } catch (error) {
    console.error('Error notificando lista de espera:', error);
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
  '¿En qué te ayudo?\n' +
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

async function buildProfesionalesKeyboard(servicioNombre?: string) {
  const profesionales = await getProfesionales();
  const servicios = await getServiciosList();
  const svcIdx =
    servicioNombre != null
      ? servicios.findIndex(s => s.nombre === servicioNombre)
      : -1;
  // svc en el callback: si se pierde el estado en KV, igual recuperamos el servicio
  const svcSuffix = svcIdx >= 0 ? `:s${svcIdx}` : '';

  return [
    ...profesionales.map((p, i) => [
      { text: p, callback_data: `prof_idx:${i}${svcSuffix}` }
    ]),
    [{ text: '🎲 Al azar', callback_data: `aleatorio_profesional${svcSuffix}` }],
    [BTN.MENU]
  ];
}

async function resolveProfesionalFromCallback(
  data: string
): Promise<{ profesional: string; servicio?: string } | null> {
  const servicios = await getServiciosList();
  const profesionales = await getProfesionales();

  // aleatorio_profesional or aleatorio_profesional:s0
  if (data === 'aleatorio_profesional' || data.startsWith('aleatorio_profesional:')) {
    const prof = profesionales[Math.floor(Math.random() * profesionales.length)];
    const svcMatch = data.match(/:s(\d+)$/);
    const servicio =
      svcMatch && servicios[parseInt(svcMatch[1], 10)]
        ? servicios[parseInt(svcMatch[1], 10)].nombre
        : undefined;
    return { profesional: prof, servicio };
  }

  // prof_idx:0 or prof_idx:0:s1
  if (data.startsWith('prof_idx:')) {
    const parts = data.replace('prof_idx:', '').split(':');
    const pIdx = parseInt(parts[0] || '', 10);
    if (Number.isNaN(pIdx) || !profesionales[pIdx]) return null;
    let servicio: string | undefined;
    if (parts[1]?.startsWith('s')) {
      const sIdx = parseInt(parts[1].slice(1), 10);
      if (!Number.isNaN(sIdx) && servicios[sIdx]) servicio = servicios[sIdx].nombre;
    }
    return { profesional: profesionales[pIdx], servicio };
  }

  // legacy: profesional:Nombre
  if (data.startsWith('profesional:')) {
    return { profesional: data.replace('profesional:', '') };
  }

  return null;
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
  saveState: (s: StatePatch) => Promise<void>,
  sendWithKeyboard: (t: string, k?: any) => Promise<void>,
  prefix = ''
) {
  const intro = prefix || `*${profSeleccionado}* ✔️\n\n`;
  const servicio = estado.servicio;

  if (servicio) {
    // Chatbot: si ya hay fecha, mostrar cupos (no reiniciar eligiendo día)
    if (estado.fecha) {
      const nombre = await resolvePatientNombre(chatId, {
        ...estado,
        profesional: profSeleccionado,
        servicio,
      });
      if (!nombre && !estado.rescheduleId) {
        const step = await buildNombreStep(
          { ...estado, profesional: profSeleccionado, servicio, fecha: estado.fecha },
          chatId,
          intro
        );
        await saveState(step.estado);
        await sendWithKeyboard(step.text, step.keyboard);
        return;
      }
      await saveState({
        ...estado,
        paso: 'hora',
        profesional: profSeleccionado,
        servicio,
        fecha: estado.fecha,
        ...(nombre ? { nombre } : {}),
        clear: ['hora'],
      });
      const view = await buildHorariosView(
        estado.fecha,
        servicio,
        profSeleccionado,
        estado.rescheduleId
      );
      await sendWithKeyboard(
        `${intro}${nombre ? `Hola *${nombre}* 👋\n\n` : ''}${view.text}`,
        view.keyboard
      );
      return;
    }

    if (estado.nombre || estado.rescheduleId) {
      const nombre = sanitizePersonName(estado.nombre);
      if (!nombre && !estado.rescheduleId) {
        const step = await buildNombreStep(
          { ...estado, profesional: profSeleccionado, servicio },
          chatId,
          intro
        );
        await saveState(step.estado);
        await sendWithKeyboard(step.text, step.keyboard);
        return;
      }
      await saveState({
        ...estado,
        paso: 'fecha',
        profesional: profSeleccionado,
        servicio,
        ...(nombre ? { nombre } : {}),
      });
      const view = await buildFechasView(servicio, profSeleccionado);
      await sendWithKeyboard(
        `${intro}${nombre ? `Hola *${nombre}* 👋\n\n` : ''}${view.text}`,
        view.keyboard
      );
    } else {
      const step = await buildNombreStep(
        { ...estado, profesional: profSeleccionado, servicio },
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

/** Elegir servicio (botón o texto). Respeta fecha ya pedida en el chatbot. */
async function applyServicioSelection(
  chatId: number,
  estado: ConversationState,
  servicioSeleccionado: string,
  saveState: (s: StatePatch) => Promise<void>,
  sendWithKeyboard: (t: string, k?: any) => Promise<void>
) {
  if (!estado.profesional) {
    const limitReached = await checkReservationLimit(chatId);
    if (limitReached && !estado.paso) {
      await sendWithKeyboard(buildLimitReachedMessage(MAX_RESERVACIONES_POR_USUARIO), [
        [BTN.MIS_RESERVAS],
        [BTN.MENU],
      ]);
      return;
    }
    if (estado.fecha) {
      const profs = await getProfesionales();
      const conCupo: string[] = [];
      for (const p of profs) {
        const libres = await obtenerHorariosLibres(
          estado.fecha,
          p,
          servicioSeleccionado,
          estado.rescheduleId
        );
        if (libres.length > 0) conCupo.push(p);
      }
      if (conCupo.length === 1) {
        await continueAfterProfessional(
          chatId,
          { ...estado, servicio: servicioSeleccionado, fecha: estado.fecha },
          conCupo[0],
          saveState,
          sendWithKeyboard,
          `*${servicioSeleccionado}* ✔️\n\n`
        );
        return;
      }
      await saveState({
        paso: 'profesional',
        servicio: servicioSeleccionado,
        fecha: estado.fecha,
        ...(estado.nombre ? { nombre: estado.nombre } : {}),
        ...(estado.rescheduleId ? { rescheduleId: estado.rescheduleId } : {}),
        clear: ['profesional', 'hora'],
      });
      await sendWithKeyboard(
        `*${servicioSeleccionado}* ✔️\n\n¿Con qué profesional te querés atender?`,
        await buildProfesionalesKeyboard(servicioSeleccionado)
      );
      return;
    }
    await saveState({
      paso: 'profesional',
      servicio: servicioSeleccionado,
      clear: ['profesional', 'fecha', 'hora'],
    });
    await sendWithKeyboard(
      `*${servicioSeleccionado}* ✔️\n\n¿Con qué profesional te querés atender?`,
      await buildProfesionalesKeyboard(servicioSeleccionado)
    );
    return;
  }

  if ((estado.nombre || estado.rescheduleId) && estado.fecha) {
    await saveState({ ...estado, paso: 'hora', servicio: servicioSeleccionado });
    const view = await buildHorariosView(
      estado.fecha,
      servicioSeleccionado,
      estado.profesional,
      estado.rescheduleId
    );
    await sendWithKeyboard(view.text, view.keyboard);
    return;
  }

  if (estado.fecha) {
    // Hay fecha + profesional, falta nombre
    const nombre = await resolvePatientNombre(chatId, {
      ...estado,
      servicio: servicioSeleccionado,
    });
    if (nombre) {
      await saveState({
        ...estado,
        paso: 'hora',
        servicio: servicioSeleccionado,
        nombre,
        clear: ['hora'],
      });
      const view = await buildHorariosView(
        estado.fecha,
        servicioSeleccionado,
        estado.profesional!,
        estado.rescheduleId
      );
      await sendWithKeyboard(`Hola *${nombre}* 👋\n\n${view.text}`, view.keyboard);
    } else {
      const step = await buildNombreStep(
        { ...estado, servicio: servicioSeleccionado },
        chatId,
        `*${servicioSeleccionado}* ✔️\n\n`
      );
      await saveState(step.estado);
      await sendWithKeyboard(step.text, step.keyboard);
    }
    return;
  }

  if (estado.nombre || estado.rescheduleId) {
    const nombre = sanitizePersonName(estado.nombre);
    await saveState({ ...estado, paso: 'fecha', servicio: servicioSeleccionado });
    const view = await buildFechasView(servicioSeleccionado, estado.profesional);
    await sendWithKeyboard(
      `${nombre ? `Hola *${nombre}* 👋\n\n` : ''}${view.text}`,
      view.keyboard
    );
    return;
  }

  const step = await buildNombreStep(
    { ...estado, servicio: servicioSeleccionado },
    chatId,
    `*${servicioSeleccionado}* ✔️\n\n`
  );
  await saveState(step.estado);
  await sendWithKeyboard(step.text, step.keyboard);
}

function matchServicioFromText(
  text: string,
  servicios: Array<{ nombre: string }>
): string | null {
  const normalized = normalizeHumanText(text);
  if (['al azar', 'aleatorio', 'cualquiera', 'da igual', 'me da igual'].some(w => normalized.includes(w))) {
    return servicios[Math.floor(Math.random() * servicios.length)]?.nombre || null;
  }
  const num = parseInt(text, 10);
  if (!isNaN(num) && num >= 1 && num <= servicios.length) {
    return servicios[num - 1].nombre;
  }
  return servicios.find(s => matchesLoosely(s.nombre, text))?.nombre || null;
}

/** Flujo canónico: profesional → servicio → nombre → fecha → hora. */
async function startBookingWithProfessional(
  saveState: (s: StatePatch) => Promise<void>,
  sendWithKeyboard: (t: string, k?: any) => Promise<void>,
  intro = '¿Con qué profesional te querés atender?',
  keep?: Pick<ConversationState, 'fecha' | 'nombre'>,
  chatId?: number
) {
  await saveState({
    paso: 'profesional',
    ...(keep?.fecha ? { fecha: keep.fecha } : {}),
    ...(keep?.nombre ? { nombre: keep.nombre } : {}),
    clear: (
      ['profesional', 'servicio', 'nombre', 'fecha', 'hora', 'rescheduleId'] as const
    ).filter(k => !(keep && k in keep && (keep as any)[k] !== undefined)),
  });

  const keyboard = await buildProfesionalesKeyboard();
  if (chatId) {
    const profile = await getUserProfile(chatId, kv);
    if (profile?.lastProfesional && profile?.lastServicio) {
      keyboard.unshift([buildRebookButton(profile.lastProfesional, profile.lastServicio)]);
    }
  }

  await sendWithKeyboard(
    withFlowProgress('profesional', intro),
    keyboard
  );
}

/** Si faltan datos a mitad de flujo: primero doctor, después servicio. */
async function promptMissingProfOrServicio(
  estado: ConversationState,
  saveState: (s: StatePatch) => Promise<void>,
  sendWithKeyboard: (t: string, k?: any) => Promise<void>
) {
  if (!estado.profesional) {
    await saveState({
      paso: 'profesional',
      ...(estado.servicio ? { servicio: estado.servicio } : {}),
      ...(estado.nombre ? { nombre: estado.nombre } : {}),
      ...(estado.fecha ? { fecha: estado.fecha } : {}),
      ...(estado.rescheduleId ? { rescheduleId: estado.rescheduleId } : {}),
    });
    await sendWithKeyboard(
      withFlowProgress(
        'profesional',
        '⚠️ Me faltó el profesional. ¿Con quién te querés atender?'
      ),
      await buildProfesionalesKeyboard(estado.servicio)
    );
    return;
  }

  await saveState({
    paso: 'servicio',
    profesional: estado.profesional,
    ...(estado.nombre ? { nombre: estado.nombre } : {}),
    ...(estado.fecha ? { fecha: estado.fecha } : {}),
    ...(estado.rescheduleId ? { rescheduleId: estado.rescheduleId } : {}),
  });
  await sendWithKeyboard(
    withFlowProgress(
      'servicio',
      '⚠️ Me faltó el servicio. ¿Qué sesión querés?'
    ),
    await buildServiciosKeyboard(true)
  );
}

async function getContextualKeyboard(estado: ConversationState, _chatId?: number): Promise<any[][]> {
  switch (estado.paso) {
    case 'profesional':
      return buildProfesionalesKeyboard(estado.servicio);
    case 'servicio':
      return buildServiciosKeyboard(true);
    case 'nombre':
      return FLOW_CANCEL_KEYBOARD;
    case 'fecha':
      return await buildFechasKeyboard(estado.profesional, estado.servicio, estado.rescheduleId);
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
  const known =
    sanitizePersonName(estado.nombre) || sanitizePersonName(profile?.nombre);

  if (known) {
    return {
      estado: { ...estado, paso: 'nombre', nombre: known } as StatePatch,
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

  const { nombre: _omitNombre, ...rest } = estado;
  return {
    estado: { ...rest, paso: 'nombre', clear: ['nombre'] } as StatePatch,
    text: withFlowProgress('nombre', `${prefix}¿Cuál es tu nombre?`),
    keyboard: FLOW_CANCEL_KEYBOARD
  };
}

const POST_BOOKING_KEYBOARD = [[BTN.MIS_RESERVAS], [BTN.MENU]];

const DAY_NAMES = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

function formatScheduleDayRanges(
  schedule: Record<number, Array<{ inicio: string; fin: string }>>
): string[] {
  const days = Object.keys(schedule)
    .map(Number)
    .sort((a, b) => a - b);
  const lines: string[] = [];
  let i = 0;
  while (i < days.length) {
    const start = days[i];
    const slotText = (schedule[start] || [])
      .map(slot => `${slot.inicio}–${slot.fin}`)
      .join(' y ');
    let end = start;
    while (
      i + 1 < days.length &&
      days[i + 1] === end + 1 &&
      (schedule[days[i + 1]] || []).map(s => `${s.inicio}–${s.fin}`).join(' y ') === slotText
    ) {
      i += 1;
      end = days[i];
    }
    const label =
      start === end
        ? DAY_NAMES[start]
        : `${DAY_NAMES[start].slice(0, 3)}–${DAY_NAMES[end].slice(0, 3)}`;
    lines.push(`• *${label}:* ${slotText}`);
    i += 1;
  }
  return lines;
}

async function buildHorariosInfoMessage(): Promise<string> {
  const config = await getConfig();
  let message = '⏰ *Horarios de atención*\n\n*(Atención particular, sin obra social)*\n\n';

  for (const [profesional, schedule] of Object.entries(config.profesionales)) {
    message += `👨‍⚕️ *${profesional}*\n`;
    message += `${formatScheduleDayRanges(schedule).join('\n')}\n\n`;
  }

  message += 'Si querés, te ayudo a reservar un turno 👇';
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

  context +=
    '\nAgenda semanal ORIENTATIVA (NO son turnos libres; para cupos usá siempre get_availability):\n';
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
  context += 'Formas de pago: efectivo, transferencia y Mercado Pago (en el consultorio).\n';
  context += 'Cancelaciones: el paciente puede cancelar o reprogramar desde Mis reservas en el bot; pedir anticipación cuando sea posible.\n';
  context += 'Qué traer: ropa cómoda; llegar unos minutos antes.\n';
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
- Usuario pregunta por su turno / mis reservas / a qué hora es / ya reservé → action: "misreservas"

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

  // Sin flujo: la UX de navegación la manda el intent local.
  // Con flujo activo: NO pisar con reservar/servicios (eso reiniciaba y "saltaba").
  const navActions = new Set(['servicios', 'reservar', 'misreservas', 'profesionales', 'menu']);
  if (localIntent && navActions.has(localIntent.action)) {
    if (hasActiveFlow && localIntent.action !== 'menu') {
      // Seguir en el paso; el webhook avanza o re-pregunta
      return {
        responseText: aiResult.responseText || '',
        intent: { action: 'reservar', parameters: aiResult.intent?.parameters },
        shouldContinueWithFlow: true,
      };
    }

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
        shouldContinueWithFlow: false,
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

async function loadUserReservations(chatId: number): Promise<Reservation[]> {
  if (kv) {
    const userReservasKey = `user:${chatId}:reservas`;
    const userReservas = (await kv.get(userReservasKey)) || [];
    const rawArray = Array.isArray(userReservas)
      ? userReservas
      : JSON.parse(userReservas as string);

    const validReservations: Reservation[] = [];
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
    return validReservations;
  }

  return getLocalReservations().filter(r => r.chatId === chatId);
}

function filterUpcomingReservations(reservasArray: Reservation[], nowMs = Date.now()): Reservation[] {
  return reservasArray
    .filter(r => {
      // Interpretar fecha/hora en ART (UTC-3), no en TZ del server
      const at = Date.parse(`${r.fecha}T${r.hora}:00-03:00`);
      return !Number.isNaN(at) && at >= nowMs - 60 * 60 * 1000;
    })
    .sort((a, b) => `${a.fecha}T${a.hora}`.localeCompare(`${b.fecha}T${b.hora}`));
}

async function buildMisReservasKeyboard(reservasArray: Reservation[]) {
  const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
  const futuras = filterUpcomingReservations(reservasArray);

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

async function startRescheduleForReserva(
  reserva: Reservation,
  saveState: (patch: StatePatch) => Promise<void>,
  sendWithKeyboard: (text: string, keyboard: any) => Promise<void>
) {
  await saveState({
    paso: 'fecha',
    rescheduleId: reserva.id,
    profesional: reserva.profesional,
    servicio: reserva.servicio,
    nombre: reserva.nombre,
    fecha: reserva.fecha,
    hora: reserva.hora,
  });
  const view = await buildFechasView(reserva.servicio, reserva.profesional, reserva.id);
  const shortName = reserva.profesional.split(' ')[0];
  await sendWithKeyboard(
    `🔄 *Cambiar turno*\n\n` +
      `Ahora tenés *${formatDateShortSafe(reserva.fecha)}* a las *${reserva.hora}* ` +
      `(*${reserva.servicio}* con *${shortName}*).\n\n` +
      `Elegí la nueva fecha:`,
    view.keyboard
  );
}

async function showCancelConfirm(
  reserva: Reservation,
  sendWithKeyboard: (text: string, keyboard: any) => Promise<void>
) {
  await sendWithKeyboard(
    `⚠️ *¿Cancelar este turno?*\n\n` +
      `👨‍⚕️ ${reserva.profesional}\n` +
      `🩺 ${reserva.servicio}\n` +
      `📅 ${formatDateAR(reserva.fecha)} · ${reserva.hora}\n\n` +
      `Esta acción no se puede deshacer.`,
    [
      [{ text: '✅ Sí, cancelar turno', callback_data: `eliminar:${reserva.id}` }],
      [{ text: '↩️ Volver', callback_data: 'misreservas' }],
    ]
  );
}

function buildAgentConfirmKeyboard(isReschedule = false): Array<
  Array<{ text: string; callback_data: string }>
> {
  return [
    [
      {
        text: '✅ Confirmar',
        callback_data: isReschedule ? 'confirmar_reprogramar' : 'confirmar_reserva',
      },
    ],
    [
      { text: '🕐 Otra hora', callback_data: 'refresh_horarios' },
      { text: '📅 Otra fecha', callback_data: 'cambiar_fecha' },
    ],
    [BTN.MENU],
  ];
}

function makeAssistantHandlers(chatId: number): AssistantToolHandlers {
  const holdSlot: AssistantToolHandlers['holdSlot'] = async args => {
    const profesionales = await getProfesionales();
    const serviciosList = await getServiciosList();
    const profesional = profesionales.find(p => matchesLoosely(p, args.profesional));
    const servicio = serviciosList.find(s => matchesLoosely(s.nombre, args.servicio))?.nombre;
    const fecha =
      args.fecha && /^\d{4}-\d{2}-\d{2}$/.test(args.fecha)
        ? args.fecha
        : parseFecha(args.fecha);

    let hora = args.hora.trim();
    if (/^\d{1,2}$/.test(hora)) hora = `${hora.padStart(2, '0')}:00`;
    else if (/^\d{1,2}:\d{2}$/.test(hora)) {
      const [h, m] = hora.split(':').map(Number);
      hora = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }

    if (!profesional || !servicio || !fecha) {
      return {
        data: {
          held: false,
          need: {
            profesional: !profesional,
            servicio: !servicio,
            fecha: !fecha,
          },
          note: 'Faltan datos para trabar el turno. Pedí lo que falte o llamá get_availability.',
        },
      };
    }

    const estado = await loadConversationState(chatId);
    const rescheduleOptions = await getRescheduleOptions(chatId, estado.rescheduleId);
    const disponibilidad = await verificarDisponibilidad(
      profesional,
      servicio,
      fecha,
      hora,
      rescheduleOptions
    );

    if (!disponibilidad.disponible) {
      const slots = await obtenerHorariosLibres(fecha, profesional, servicio);
      const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
      for (let i = 0; i < Math.min(slots.length, 9); i += 3) {
        keyboard.push(
          slots.slice(i, i + 3).map(h => ({
            text: `🕐 ${h}`,
            callback_data: `hora:${h}`,
          }))
        );
      }
      keyboard.push([BTN.MENU]);
      return {
        data: {
          held: false,
          available: false,
          reason: disponibilidad.mensaje || 'Horario no disponible',
          fecha,
          fechaLabel: formatDateAR(fecha),
          profesional,
          servicio,
          requestedHora: hora,
          slots,
        },
        keyboard,
        sideEffect: {
          type: 'set_draft',
          draft: {
            paso: 'hora',
            profesional,
            servicio,
            fecha,
            ...(estado.nombre ? { nombre: estado.nombre } : {}),
            ...(estado.rescheduleId ? { rescheduleId: estado.rescheduleId } : {}),
          },
        },
      };
    }

    const nombre = await resolvePatientNombre(chatId, estado, args.nombre);
    const isReschedule = Boolean(estado.rescheduleId);

    if (!nombre) {
      return {
        data: {
          held: true,
          needNombre: true,
          fecha,
          fechaLabel: formatDateAR(fecha),
          weekday: DAY_NAMES[dayOfWeekFromFechaStr(fecha)],
          profesional,
          servicio,
          hora,
          note:
            'Turno trabado. Pedí el nombre del paciente. En el próximo mensaje llamá set_patient_name. No digas "undefined".',
        },
        keyboard: [[BTN.CANCEL_FLOW], [BTN.MENU]],
        sideEffect: {
          type: 'set_draft',
          draft: {
            paso: 'nombre',
            profesional,
            servicio,
            fecha,
            hora,
            clear: ['nombre'],
            ...(estado.rescheduleId ? { rescheduleId: estado.rescheduleId } : {}),
          },
        },
      };
    }

    return {
      data: {
        held: true,
        needNombre: false,
        readyToConfirm: true,
        fecha,
        fechaLabel: formatDateAR(fecha),
        weekday: DAY_NAMES[dayOfWeekFromFechaStr(fecha)],
        profesional,
        servicio,
        hora,
        nombre,
        isReschedule,
        note: 'Turno listo para confirmar. Escribí vos el resumen; el teclado tiene Confirmar.',
      },
      keyboard: buildAgentConfirmKeyboard(isReschedule),
      sideEffect: {
        type: 'set_draft',
        draft: {
          paso: 'confirmar',
          profesional,
          servicio,
          fecha,
          hora,
          nombre,
          ...(estado.rescheduleId ? { rescheduleId: estado.rescheduleId } : {}),
        },
      },
    };
  };

  const setPatientName: AssistantToolHandlers['setPatientName'] = async args => {
    const estado = await loadConversationState(chatId);
    const extracted = extractPersonName(args.nombre);
    if (!extracted) {
      return {
        data: {
          accepted: false,
          needNombre: true,
          error: 'nombre_invalido',
          note:
            'Ese texto no sirve como nombre. Pedí el nombre real (ej. María López), sin números ni frases largas.',
        },
        keyboard: [[BTN.CANCEL_FLOW], [BTN.MENU]],
        sideEffect: {
          type: 'set_draft',
          draft: {
            paso: 'nombre',
            ...(estado.profesional ? { profesional: estado.profesional } : {}),
            ...(estado.servicio ? { servicio: estado.servicio } : {}),
            ...(estado.fecha ? { fecha: estado.fecha } : {}),
            ...(estado.hora ? { hora: estado.hora } : {}),
            ...(estado.rescheduleId ? { rescheduleId: estado.rescheduleId } : {}),
          },
        },
      };
    }

    const nombre = capitalizeName(extracted);
    await saveUserProfile(chatId, nombre, kv);
    const isReschedule = Boolean(estado.rescheduleId);

    if (estado.fecha && estado.hora && estado.profesional && estado.servicio) {
      return {
        data: {
          accepted: true,
          readyToConfirm: true,
          needNombre: false,
          nombre,
          profesional: estado.profesional,
          servicio: estado.servicio,
          fecha: estado.fecha,
          fechaLabel: formatDateAR(estado.fecha),
          hora: estado.hora,
          isReschedule,
          note: 'Nombre guardado. Escribí vos el resumen y pedí confirmación; el teclado tiene Confirmar.',
        },
        keyboard: buildAgentConfirmKeyboard(isReschedule),
        sideEffect: {
          type: 'set_draft',
          draft: {
            paso: 'confirmar',
            profesional: estado.profesional,
            servicio: estado.servicio,
            fecha: estado.fecha,
            hora: estado.hora,
            nombre,
            ...(estado.rescheduleId ? { rescheduleId: estado.rescheduleId } : {}),
          },
        },
      };
    }

    const keyboard =
      estado.servicio || estado.profesional
        ? (await buildFechasView(estado.servicio, estado.profesional, estado.rescheduleId)).keyboard
        : FLOW_CANCEL_KEYBOARD;

    return {
      data: {
        accepted: true,
        readyToConfirm: false,
        needNombre: false,
        needFecha: true,
        nombre,
        profesional: estado.profesional || null,
        servicio: estado.servicio || null,
        note: 'Nombre guardado. Seguí pidiendo fecha/hora según lo que falte; no reinicies el flujo.',
      },
      keyboard,
      sideEffect: {
        type: 'set_draft',
        draft: {
          paso: 'fecha',
          nombre,
          ...(estado.profesional ? { profesional: estado.profesional } : {}),
          ...(estado.servicio ? { servicio: estado.servicio } : {}),
          ...(estado.rescheduleId ? { rescheduleId: estado.rescheduleId } : {}),
        },
      },
    };
  };


  const confirmBooking: AssistantToolHandlers['confirmBooking'] = async args => {
    const estado = await loadConversationState(chatId);
    if (!args.confirm) {
      return {
        data: { booked: false, cancelled: true, note: 'Armado cancelado. Avisá al paciente en prosa.' },
        keyboard: ASSIST_KEYBOARD,
        sideEffect: { type: 'clear_draft' },
      };
    }

    if (!estado.fecha || !estado.hora || !estado.profesional || !estado.servicio) {
      return {
        data: {
          booked: false,
          error: 'draft_incompleto',
          note: 'Falta hold_slot / datos antes de confirmar.',
        },
        keyboard: ASSIST_KEYBOARD,
      };
    }

    const nombreOk = await resolvePatientNombre(chatId, estado);
    if (!nombreOk) {
      return {
        data: { booked: false, needNombre: true, note: 'Falta nombre → set_patient_name.' },
        keyboard: [[BTN.CANCEL_FLOW], [BTN.MENU]],
        sideEffect: {
          type: 'set_draft',
          draft: {
            paso: 'nombre',
            profesional: estado.profesional,
            servicio: estado.servicio,
            fecha: estado.fecha,
            hora: estado.hora,
            ...(estado.rescheduleId ? { rescheduleId: estado.rescheduleId } : {}),
          },
        },
      };
    }

    const rescheduleOptions = await getRescheduleOptions(chatId, estado.rescheduleId);
    const disponibilidad = await verificarDisponibilidad(
      estado.profesional,
      estado.servicio,
      estado.fecha,
      estado.hora,
      rescheduleOptions
    );

    if (!disponibilidad.disponible) {
      const view = await buildHorariosView(
        estado.fecha,
        estado.servicio,
        estado.profesional,
        estado.rescheduleId
      );
      return {
        data: {
          booked: false,
          available: false,
          reason: disponibilidad.mensaje || 'Horario no disponible',
        },
        keyboard: view.keyboard,
        sideEffect: {
          type: 'set_draft',
          draft: {
            paso: 'hora',
            profesional: estado.profesional,
            servicio: estado.servicio,
            fecha: estado.fecha,
            nombre: nombreOk,
            ...(estado.rescheduleId ? { rescheduleId: estado.rescheduleId } : {}),
          },
        },
      };
    }

    if (estado.rescheduleId) {
      const reserva = await reprogramarReserva(
        chatId,
        estado.rescheduleId,
        estado.fecha,
        estado.hora
      );
      if (!reserva) {
        return { data: { booked: false, error: 'reprogramar_fallo' }, keyboard: ASSIST_KEYBOARD };
      }
      return {
        data: {
          booked: true,
          isReschedule: true,
          reserva: {
            id: reserva.id,
            fecha: reserva.fecha,
            hora: reserva.hora,
            profesional: reserva.profesional,
            servicio: reserva.servicio,
            nombre: reserva.nombre,
          },
          note: 'Reprogramación OK. Confirmá al paciente en prosa con los datos de reserva.',
        },
        keyboard: POST_BOOKING_KEYBOARD,
        sideEffect: { type: 'clear_draft' },
      };
    }

    const reserva = await guardarReserva(chatId, {
      profesional: estado.profesional,
      servicio: estado.servicio,
      nombre: nombreOk,
      fecha: estado.fecha,
      hora: estado.hora,
      chatId,
    });

    if (!reserva) {
      const view = await buildHorariosView(estado.fecha, estado.servicio, estado.profesional);
      return {
        data: { booked: false, reason: 'race_taken' },
        keyboard: view.keyboard,
      };
    }

    return {
      data: {
        booked: true,
        isReschedule: false,
        reserva: {
          id: reserva.id,
          fecha: reserva.fecha,
          hora: reserva.hora,
          profesional: reserva.profesional,
          servicio: reserva.servicio,
          nombre: reserva.nombre,
        },
        note: 'Reserva OK. Confirmá al paciente en prosa con los datos de reserva.',
      },
      keyboard: POST_BOOKING_KEYBOARD,
      sideEffect: { type: 'clear_draft' },
    };
  };


  return {
    holdSlot,
    setPatientName,
    confirmBooking,

    async getClinicInfo(topic: ClinicInfoTopic) {
      // Solo HECHOS: Gemini escribe el mensaje. No devolver copy listo para el paciente.
      const config = await getConfig();
      const servicios = await getServiciosList();
      let keyboard: typeof ASSIST_KEYBOARD | Awaited<ReturnType<typeof buildServiciosKeyboard>> =
        ASSIST_KEYBOARD;
      let facts: Record<string, unknown> = { topic };

      switch (topic) {
        case 'horarios': {
          const porProfesional: Record<string, string[]> = {};
          for (const [profesional, schedule] of Object.entries(config.profesionales)) {
            porProfesional[profesional] = Object.keys(schedule)
              .map(Number)
              .sort((a, b) => a - b)
              .map(day => {
                const slots = schedule[day];
                const slotText = slots.map(s => `${s.inicio}-${s.fin}`).join(', ');
                return `${DAY_NAMES[day]}: ${slotText}`;
              });
          }
          facts = { topic, porProfesional, atencion: 'particular' };
          break;
        }
        case 'precios':
          facts = {
            topic,
            servicios: servicios.map(s => ({
              nombre: s.nombre,
              precio: s.precio,
              duracionMinutos: s.duracionMinutos,
            })),
          };
          keyboard = await buildServiciosKeyboard(false);
          break;
        case 'ubicacion':
          facts = {
            topic,
            direccion: getClinicAddress(),
            mapsUrl: getClinicMapsUrl(),
          };
          break;
        case 'pago':
          facts = {
            topic,
            medios: ['efectivo', 'transferencia', 'Mercado Pago'],
            donde: 'en el consultorio',
            obraSocial: false,
          };
          break;
        case 'obra_social':
          facts = { topic, aceptaObraSocial: false, atencion: 'particular' };
          break;
        case 'que_traer':
          facts = {
            topic,
            items: ['ropa cómoda', 'llegar unos minutos antes'],
            ordenMedica: false,
          };
          break;
        case 'estacionamiento':
          facts = {
            topic,
            direccion: getClinicAddress(),
            nota: 'estacionamiento en la zona / cuadra',
          };
          break;
        case 'duracion':
          facts = {
            topic,
            servicios: servicios.map(s => ({
              nombre: s.nombre,
              duracionMinutos: s.duracionMinutos,
            })),
          };
          break;
        case 'cancelacion':
          facts = {
            topic,
            puedeCancelarPorBot: true,
            recordatorios: ['24h', '1h'],
            pedirAnticipacion: true,
          };
          break;
        default:
          facts = { topic, resumen: await buildClinicContextForAI() };
          break;
      }

      return { data: { topic, facts }, keyboard };
    },

    async getMyAppointments(action: AppointmentsAction) {
      const all = await loadUserReservations(chatId);
      const futuras = filterUpcomingReservations(all);
      return buildAppointmentsToolResult(futuras, all.length - futuras.length, action);
    },

    async getAvailability(args) {
      {
        const heldNow = await loadConversationState(chatId);
        if (
          heldNow.hora &&
          heldNow.fecha &&
          heldNow.profesional &&
          heldNow.servicio &&
          (heldNow.paso === 'confirmar' || heldNow.paso === 'nombre')
        ) {
          return {
            data: {
              held: true,
              preserved: true,
              profesional: heldNow.profesional,
              servicio: heldNow.servicio,
              fecha: heldNow.fecha,
              hora: heldNow.hora,
              nombre: heldNow.nombre || null,
              note:
                'Ya hay un turno trabado. No listes cupos nuevos ni pises el draft. Pedí confirmación o cambios explícitos (otra hora → hold_slot).',
            },
            keyboard:
              heldNow.paso === 'confirmar'
                ? buildAgentConfirmKeyboard(Boolean(heldNow.rescheduleId))
                : [[BTN.CANCEL_FLOW], [BTN.MENU]],
          };
        }
      }
      const profesionales = await getProfesionales();
      const serviciosList = await getServiciosList();
      const servicioNombres = serviciosList.map(s => s.nombre);
      const draft = await loadConversationState(chatId);

      const profesionalFilter = args.profesional
        ? profesionales.find(p => matchesLoosely(p, args.profesional!))
        : draft.profesional
          ? profesionales.find(p => matchesLoosely(p, draft.profesional!))
          : undefined;
      const servicioFilter = args.servicio
        ? serviciosList.find(s => matchesLoosely(s.nombre, args.servicio!))?.nombre
        : draft.servicio
          ? serviciosList.find(s => matchesLoosely(s.nombre, draft.servicio!))?.nombre
          : undefined;

      const fecha =
        args.fecha && /^\d{4}-\d{2}-\d{2}$/.test(args.fecha)
          ? args.fecha
          : args.fecha
            ? parseFecha(args.fecha)
            : null;

      const toMins = (h: string) => {
        const [hh, mm] = h.split(':').map(Number);
        return hh * 60 + (mm || 0);
      };

      const filterSlots = (slots: string[]) => {
        let out = slots;
        if (args.franja) {
          out = out.filter(h =>
            args.franja === 'tarde' ? toMins(h) >= 14 * 60 : toMins(h) < 14 * 60
          );
        }
        if (args.horaDesde) {
          const from = toMins(args.horaDesde);
          out = out.filter(h => toMins(h) >= from);
        }
        if (args.horaHasta) {
          const to = toMins(args.horaHasta);
          // slot debe empezar antes del fin de ventana
          out = out.filter(h => toMins(h) < to);
        }
        return out;
      };

      const dias = await proximosDiasLaborables(6, profesionalFilter, servicioFilter);
      const diasKeyboard: Array<Array<{ text: string; callback_data: string }>> = [];
      for (let i = 0; i < Math.min(dias.length, 6); i += 2) {
        diasKeyboard.push(
          dias.slice(i, i + 2).map(d => ({
            text: `📅 ${d.label}`,
            callback_data: `fecha:${d.fecha}`,
          }))
        );
      }
      diasKeyboard.push([BTN.MENU]);

      if (!fecha) {
        return {
          data: {
            fecha: null,
            need: { fecha: true },
            upcomingDays: dias,
            note: 'Pedí la fecha al paciente o pasá fecha YYYY-MM-DD.',
          },
          keyboard: diasKeyboard,
          // Importante: deja el draft en "fecha" para que "lunes 20" no caiga al menú
          sideEffect: {
            type: 'set_draft',
            draft: {
              paso: 'fecha',
              ...(profesionalFilter ? { profesional: profesionalFilter } : {}),
              ...(servicioFilter ? { servicio: servicioFilter } : {}),
              ...(draft.nombre ? { nombre: draft.nombre } : {}),
            },
          },
        };
      }

      if (await isFeriado(fecha)) {
        return {
          data: {
            fecha,
            fechaLabel: formatDateAR(fecha),
            weekday: DAY_NAMES[dayOfWeekFromFechaStr(fecha)],
            feriado: true,
            closedReason: 'feriado',
            options: [],
            upcomingDays: dias,
          },
          keyboard: diasKeyboard,
          sideEffect: {
            type: 'set_draft',
            draft: { paso: 'fecha', ...(profesionalFilter ? { profesional: profesionalFilter } : {}), ...(servicioFilter ? { servicio: servicioFilter } : {}) },
          },
        };
      }

      const profs = profesionalFilter ? [profesionalFilter] : profesionales;
      const servs = servicioFilter ? [servicioFilter] : servicioNombres;
      const options: Array<{
        profesional: string;
        servicio: string;
        slots: string[];
        closed?: boolean;
        dayName?: string;
      }> = [];

      for (const p of profs) {
        const laborable = await esDiaLaborable(fecha, p);
        if (!laborable) {
          options.push({
            profesional: p,
            servicio: servs[0] || '',
            slots: [],
            closed: true,
            dayName: DAY_NAMES[dayOfWeekFromFechaStr(fecha)],
          });
          continue;
        }
        for (const s of servs) {
          const slots = filterSlots(await obtenerHorariosLibres(fecha, p, s));
          if (slots.length > 0) {
            options.push({ profesional: p, servicio: s, slots });
          }
        }
      }

      const openOptions = options.filter(o => o.slots.length > 0);
      const serviciosConCupo = [...new Set(openOptions.map(o => o.servicio))];
      // No asumir Quiropraxia: si el paciente no eligió servicio y hay más de uno, pedir elección
      const needServiceChoice = !servicioFilter && serviciosConCupo.length > 1;

      let recommendation: {
        profesional: string;
        servicio: string;
        hora: string;
        reason: string;
      } | null = null;

      if (args.horaPreferida) {
        const pref = args.horaPreferida;
        const exactMatches = openOptions.filter(o => o.slots.includes(pref));
        if (exactMatches.length === 1) {
          recommendation = {
            profesional: exactMatches[0].profesional,
            servicio: exactMatches[0].servicio,
            hora: pref,
            reason: 'hora_exacta',
          };
        } else if (exactMatches.length > 1 && !needServiceChoice) {
          recommendation = {
            profesional: exactMatches[0].profesional,
            servicio: exactMatches[0].servicio,
            hora: pref,
            reason: 'hora_exacta',
          };
        } else if (exactMatches.length === 0 && openOptions.length > 0 && !needServiceChoice) {
          let best: { o: (typeof openOptions)[0]; hora: string; dist: number } | null = null;
          const prefM = toMins(pref);
          for (const o of openOptions) {
            for (const h of o.slots) {
              const dist = Math.abs(toMins(h) - prefM);
              if (!best || dist < best.dist) best = { o, hora: h, dist };
            }
          }
          if (best) {
            recommendation = {
              profesional: best.o.profesional,
              servicio: best.o.servicio,
              hora: best.hora,
              reason: 'hora_cercana',
            };
          }
        }
      } else if (openOptions.length > 0 && !needServiceChoice) {
        const first = openOptions[0];
        recommendation = {
          profesional: first.profesional,
          servicio: first.servicio,
          hora: first.slots[0],
          reason: 'primera_opcion_en_ventana',
        };
      }

      // No auto-hold: Gemini debe llamar hold_slot cuando el paciente ELIGE la hora.
      const keyboard: Array<Array<{ text: string; callback_data: string }>> = [];
      if (needServiceChoice) {
        for (const s of serviciosConCupo) {
          const idx = serviciosList.findIndex(x => x.nombre === s);
          if (idx >= 0) {
            keyboard.push([{ text: `🩺 ${s}`, callback_data: `servicio_idx:${idx}` }]);
          }
        }
      } else if (recommendation) {
        const slotsForRec =
          openOptions.find(
            o =>
              o.profesional === recommendation!.profesional &&
              o.servicio === recommendation!.servicio
          )?.slots || [recommendation.hora];
        for (let i = 0; i < Math.min(slotsForRec.length, 9); i += 3) {
          keyboard.push(
            slotsForRec.slice(i, i + 3).map(h => ({
              text: `🕐 ${h}`,
              callback_data: `hora:${h}`,
            }))
          );
        }
      } else if (openOptions.length === 0) {
        for (let i = 0; i < Math.min(dias.length, 6); i += 2) {
          keyboard.push(
            dias.slice(i, i + 2).map(d => ({
              text: `📅 ${d.label}`,
              callback_data: `fecha:${d.fecha}`,
            }))
          );
        }
      }
      keyboard.push([BTN.MENU]);

      const sideEffect =
        recommendation && !needServiceChoice
          ? {
              type: 'set_draft' as const,
              draft: {
                paso: 'hora' as const,
                profesional: recommendation.profesional,
                servicio: recommendation.servicio,
                fecha,
                ...(draft.nombre ? { nombre: draft.nombre } : {}),
              },
            }
          : {
              type: 'set_draft' as const,
              draft: {
                paso: needServiceChoice ? ('servicio' as const) : ('fecha' as const),
                ...(profesionalFilter ? { profesional: profesionalFilter } : {}),
                ...(servicioFilter ? { servicio: servicioFilter } : {}),
                fecha,
                ...(draft.nombre ? { nombre: draft.nombre } : {}),
              },
            };

      const matchesAtHora =
        args.horaPreferida && needServiceChoice
          ? openOptions
              .filter(o => o.slots.includes(args.horaPreferida!))
              .map(o => ({
                profesional: o.profesional,
                servicio: o.servicio,
                hora: args.horaPreferida!,
              }))
          : [];

      return {
        data: {
          fecha,
          fechaLabel: formatDateAR(fecha),
          weekday: DAY_NAMES[dayOfWeekFromFechaStr(fecha)],
          window: {
            horaDesde: args.horaDesde || null,
            horaHasta: args.horaHasta || null,
            horaPreferida: args.horaPreferida || null,
            franja: args.franja || null,
          },
          options: openOptions.map(o => ({
            profesional: o.profesional,
            servicio: o.servicio,
            slots: o.slots,
          })),
          closedProfessionals: options
            .filter(o => o.closed)
            .map(o => ({ profesional: o.profesional, dayName: o.dayName })),
          recommendation,
          needServiceChoice,
          serviciosConCupo,
          matchesAtHora,
          note: needServiceChoice
            ? 'El paciente NO eligió servicio. Preguntá cuál quiere en 1-2 líneas. NO listés servicios ni todos los horarios en el texto (van en botones). recommendation no es una elección del paciente. Formato: contexto breve + "Tocá el servicio 👇".'
            : 'Escribí 1-2 líneas. Máximo 1 ejemplo de hora/profesional. NO enumerés todos los slots (van en botones). CTA: "Elegí un horario 👇".',
          requestedHoraAvailable: args.horaPreferida
            ? openOptions.some(o => o.slots.includes(args.horaPreferida!))
            : null,
          count: openOptions.reduce((n, o) => n + o.slots.length, 0),
          upcomingDays: openOptions.length === 0 ? dias : [],
        },
        keyboard,
        sideEffect,
      };
    },
  };
}

async function showMisReservas(
  chatId: number,
  sendWithKeyboard: (text: string, keyboard: any) => Promise<void>,
  opts?: {
    mode?: MisReservasMode;
    saveState?: (patch: StatePatch) => Promise<void>;
    userText?: string;
  }
) {
  const mode = opts?.mode || 'status';
  const reservasArray = await loadUserReservations(chatId);

  if (reservasArray.length === 0) {
    await sendWithKeyboard(buildTurnoStatusMessage([]), [
      [{ text: '✅ Sí, reservar', callback_data: 'reservar' }],
      [BTN.MENU],
    ]);
    return;
  }

  const { keyboard, futuras, pastCount } = await buildMisReservasKeyboard(reservasArray);
  if (futuras.length === 0) {
    await sendWithKeyboard(buildTurnoStatusMessage([], { pastCount }), [
      [BTN.RESERVAR],
      [BTN.MENU],
    ]);
    return;
  }

  if (mode === 'change' && opts?.saveState) {
    if (futuras.length === 1) {
      await startRescheduleForReserva(futuras[0], opts.saveState, sendWithKeyboard);
      return;
    }
    await sendWithKeyboard(
      `🔄 *Cambiar turno*\n\nTenés *${futuras.length} turnos*. ¿Cuál querés cambiar?`,
      keyboard
    );
    return;
  }

  if (mode === 'cancel') {
    if (futuras.length === 1) {
      await showCancelConfirm(futuras[0], sendWithKeyboard);
      return;
    }
    await sendWithKeyboard(
      `❌ *Cancelar turno*\n\nTenés *${futuras.length} turnos*. ¿Cuál querés cancelar?`,
      keyboard
    );
    return;
  }

  const focus = opts?.userText && isTimeUntilIntent(opts.userText) ? 'time_until' : 'status';
  await sendWithKeyboard(buildTurnoStatusMessage(futuras, { pastCount, focus }), keyboard);
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

      const saveState = async (patch: StatePatch) => {
        const current = await getState();
        const { clear, ...rest } = patch;
        const payload: ConversationState = { ...current, updatedAt: Date.now() };

        // undefined = no tocar ese campo (evita borrar profesional/servicio por accidente)
        for (const [key, value] of Object.entries(rest)) {
          if (value !== undefined) {
            (payload as any)[key] = value;
          }
        }

        if (clear?.length) {
          for (const key of clear) {
            delete (payload as any)[key];
          }
        }

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
        await clearGeminiHistory(String(chatId));
        await sendWithKeyboard(WELCOME_MESSAGE, MAIN_MENU_KEYBOARD);

      } else if (data === 'profesionales') {
        await sendWithKeyboard(
          '👨‍⚕️ *Nuestros profesionales*\n\n*(Atención particular, sin obra social)*\n\nTocá uno para reservar 👇',
          await buildProfesionalesKeyboard()
        );
      } else if (data === 'servicios') {
        const servicios = await getServiciosList();
        const list = servicios
          .map(s => `• *${s.nombre}* — ${formatPriceAR(s.precio)} · ${s.duracionMinutos} min`)
          .join('\n');
        await sendWithKeyboard(
          `🩺 *Servicios*\n\n*(Atención particular, sin obra social)*\n\n${list}\n\nTocá uno para reservar 👇`,
          await buildServiciosKeyboard(false)
        );

      } else if (data === 'reservar') {
        const limitReached = await checkReservationLimit(chatId);
        if (limitReached) {
          await sendWithKeyboard(
            buildLimitReachedMessage(MAX_RESERVACIONES_POR_USUARIO),
            [[{ text: '📋 Mis reservas', callback_data: 'misreservas' }], [{ text: '🏠 Menú', callback_data: 'menu' }]]
          );
        } else {
          // Mismo camino que texto: cupos primero, sin wizard profesional→servicio
          await replyWithAvailabilityTool(chatId, { saveState, sendWithKeyboard });
        }

      } else if (data === 'rebook_last') {
        const limitReached = await checkReservationLimit(chatId);
        if (limitReached) {
          await sendWithKeyboard(
            buildLimitReachedMessage(MAX_RESERVACIONES_POR_USUARIO),
            [[{ text: '📋 Mis reservas', callback_data: 'misreservas' }], [{ text: '🏠 Menú', callback_data: 'menu' }]]
          );
        } else {
          const profile = await getUserProfile(chatId, kv);
          if (!profile?.lastProfesional || !profile?.lastServicio) {
            await replyWithAvailabilityTool(chatId, { saveState, sendWithKeyboard });
          } else {
            const step = await buildNombreStep(
              {
                paso: 'nombre',
                profesional: profile.lastProfesional,
                servicio: profile.lastServicio,
                nombre: profile.nombre,
              },
              chatId,
              `🔁 Repetimos *${profile.lastServicio}* con *${profile.lastProfesional}*\n\n`
            );
            await saveState(step.estado);
            await sendWithKeyboard(step.text, step.keyboard);
          }
        }

      } else if (data === 'misreservas') {
        await showMisReservas(chatId, sendWithKeyboard);

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
          await startRescheduleForReserva(reserva, saveState, sendWithKeyboard);
        }

      } else if (data.startsWith('confirmar_eliminar:')) {
        const reservaId = data.replace('confirmar_eliminar:', '');
        const reserva = await getReservaById(chatId, reservaId);
        if (!reserva) {
          await sendWithKeyboard('No encontré esa reserva.', [[BTN.MIS_RESERVAS], [BTN.MENU]]);
        } else {
          await showCancelConfirm(reserva, sendWithKeyboard);
        }

      } else if (data.startsWith('eliminar:')) {
        const reservaId = data.replace('eliminar:', '');
        const eliminado = await eliminarReserva(chatId, reservaId);

        if (eliminado) {
          await pingWaitlist(eliminado.profesional, eliminado.fecha);
          await sendWithKeyboard(
            `✅ Turno cancelado\n\n📅 ${formatDate(eliminado.fecha)} · ${eliminado.hora}\n🩺 ${eliminado.servicio} con ${eliminado.profesional}`,
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

      } else if (data.startsWith('wl_join:')) {
        const fecha = data.replace('wl_join:', '');
        if (!estado.profesional || !estado.servicio || !/^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
          await sendWithKeyboard(
            'Para anotarte en la lista de espera necesito profesional, servicio y fecha. Empezá de nuevo:',
            await buildProfesionalesKeyboard()
          );
        } else {
          const result = await joinWaitlist({
            chatId,
            profesional: estado.profesional,
            servicio: estado.servicio,
            fecha,
          });
          if (!result.ok) {
            await sendWithKeyboard(`⚠️ ${result.reason}`, [[BTN.MENU]]);
          } else {
            await saveState({
              paso: 'hora',
              profesional: estado.profesional,
              servicio: estado.servicio,
              fecha,
              nombre: estado.nombre,
            });
            await sendWithKeyboard(
              result.already
                ? `🔔 Ya estabas en la lista de espera para el *${formatDate(fecha)}* con *${estado.profesional}* (*${estado.servicio}*).\n\nTe aviso si se libera un turno.`
                : `🔔 *Lista de espera*\n\nTe anoté para el *${formatDate(fecha)}* con *${estado.profesional}* (*${estado.servicio}*).\n\nSi se libera un turno, te aviso por acá.`,
              [
                [{ text: '📅 Otra fecha', callback_data: 'cambiar_fecha' }],
                [BTN.MENU],
              ]
            );
          }
        }

      } else if (data.startsWith('wl_open:')) {
        const entryId = data.replace('wl_open:', '');
        const entry = await getWaitlistEntry(entryId);
        if (!entry || entry.chatId !== chatId) {
          await sendWithKeyboard('Ese aviso ya no está disponible. ¿Querés reservar de nuevo?', [
            [BTN.RESERVAR],
            [BTN.MENU],
          ]);
        } else {
          const profile = await getUserProfile(chatId, kv);
          await saveState({
            paso: 'hora',
            profesional: entry.profesional,
            servicio: entry.servicio,
            fecha: entry.fecha,
            nombre: profile?.nombre || estado.nombre,
            clear: ['hora', 'rescheduleId'],
          });
          const view = await buildHorariosView(
            entry.fecha,
            entry.servicio,
            entry.profesional
          );
          await sendWithKeyboard(
            `Perfecto — estos son los horarios libres:\n\n${view.text}`,
            view.keyboard
          );
        }

      } else if (data === 'usar_nombre') {
        if (!estado.nombre || !estado.servicio || !estado.profesional) {
          await sendWithKeyboard('Sigamos desde el principio:', await buildProfesionalesKeyboard());
        } else if (estado.fecha && estado.hora) {
          await saveState({ ...estado, paso: 'confirmar' });
          const view = await buildConfirmacionView(estado);
          await sendWithKeyboard(`Perfecto, *${estado.nombre}* 👋\n\n${view.text}`, view.keyboard);
        } else {
          await saveState({ ...estado, paso: 'fecha' });
          const view = await buildFechasView(estado.servicio, estado.profesional);
          await sendWithKeyboard(`Perfecto, *${estado.nombre}* 👋\n\n${view.text}`, view.keyboard);
        }

      } else if (data === 'cambiar_nombre') {
        await saveState({ paso: 'nombre', clear: ['nombre'] });
        await sendWithKeyboard(
          withFlowProgress('nombre', 'Dale, ¿cuál es tu nombre?'),
          FLOW_CANCEL_KEYBOARD
        );

      } else if (
        data === 'aleatorio_profesional' ||
        data.startsWith('aleatorio_profesional:') ||
        data.startsWith('prof_idx:') ||
        data.startsWith('profesional:')
      ) {
        const resolved = await resolveProfesionalFromCallback(data);
        if (!resolved) {
          await sendWithKeyboard(
            'No pude reconocer ese profesional. Elegí uno de la lista:',
            await buildProfesionalesKeyboard(estado.servicio)
          );
        } else {
          const mergedEstado: ConversationState = {
            ...estado,
            servicio: resolved.servicio || estado.servicio,
          };
          const isRandom = data.startsWith('aleatorio_profesional');
          await continueAfterProfessional(
            chatId,
            mergedEstado,
            resolved.profesional,
            saveState,
            sendWithKeyboard,
            isRandom
              ? `🎲 Te tocó *${resolved.profesional}* ✔️\n\n`
              : `*${resolved.profesional}* ✔️\n\n`
          );
        }

      } else if (data === 'aleatorio_servicio') {
        const servicios = await getServiciosList();
        const serv = servicios[Math.floor(Math.random() * servicios.length)];
        const servicioSeleccionado = serv.nombre;
        const profile = await getUserProfile(chatId, kv);
        const nombreGuardado = estado.nombre || profile?.nombre;

        if (!estado.profesional) {
          await saveState({ ...estado, paso: 'profesional', servicio: servicioSeleccionado });
          await sendWithKeyboard(
            `🎲 Te tocó *${servicioSeleccionado}* ✔️\n\n¿Con qué profesional te querés atender?`,
            await buildProfesionalesKeyboard(servicioSeleccionado)
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

      } else if (
        data.startsWith('reservar_servicio:') ||
        data.startsWith('servicio:') ||
        data.startsWith('servicio_idx:') ||
        data.startsWith('rsvc_idx:')
      ) {
        const servicioSeleccionado = await resolveServicioFromCallback(data);
        if (!servicioSeleccionado) {
          await sendWithKeyboard('No pude reconocer ese servicio. Probá de nuevo:', await buildServiciosKeyboard(true));
        } else {
          await applyServicioSelection(
            chatId,
            estado,
            servicioSeleccionado,
            saveState,
            sendWithKeyboard
          );
        }

      } else if (data === 'cambiar_fecha') {
        if (!estado.servicio || !estado.profesional) {
          await promptMissingProfOrServicio(estado, saveState, sendWithKeyboard);
        } else {
          await saveState({
            paso: 'fecha',
            servicio: estado.servicio,
            nombre: estado.nombre,
            profesional: estado.profesional,
            rescheduleId: estado.rescheduleId,
            clear: ['fecha', 'hora'],
          });
          const view = await buildFechasView(estado.servicio, estado.profesional, estado.rescheduleId);
          await sendWithKeyboard(view.text, view.keyboard);
        }

      } else if (data.startsWith('fecha:')) {
        const fechaSeleccionada = data.replace('fecha:', '');
        if (!estado.servicio || !estado.profesional) {
          await saveState({
            ...estado,
            paso: 'fecha',
            fecha: fechaSeleccionada,
            clear: ['hora'],
          });
          await replyWithAvailabilityTool(chatId, {
            fecha: fechaSeleccionada,
            saveState,
            sendWithKeyboard,
          });
        } else {
          await saveState({
            paso: 'hora',
            fecha: fechaSeleccionada,
            servicio: estado.servicio,
            profesional: estado.profesional,
            nombre: estado.nombre,
            rescheduleId: estado.rescheduleId,
            clear: ['hora'],
          });
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

        if (!estado.profesional || !estado.servicio) {
          const handlers = makeAssistantHandlers(chatId);
          const tool = await handlers.getAvailability({
            fecha: estado.fecha,
            horaPreferida: horaSeleccionada,
          });
          if (tool.sideEffect?.type === 'set_draft') {
            const d = tool.sideEffect.draft;
            await mergeDraftFromSideEffect(saveState, d);
            const merged = { ...estado, ...d };
            if (d.paso === 'confirmar' && d.hora && d.profesional && d.servicio) {
              const view = await buildConfirmacionView(merged);
              await sendWithKeyboard(view.text, view.keyboard);
              return NextResponse.json({ status: 'ok' });
            }
            if (d.paso === 'nombre' && d.hora) {
              await sendWithKeyboard(
                'Dale, ¿a nombre de quién reservo el turno?\n\nEscribí tu nombre (ej: *María López*).',
                FLOW_CANCEL_KEYBOARD
              );
              return NextResponse.json({ status: 'ok' });
            }
          }
          await sendWithKeyboard(
            buildAvailabilityFallbackMessage(
              estado.fecha ?? null,
              (tool.data || {}) as AvailabilityToolData
            ),
            tool.keyboard && tool.keyboard.length > 0 ? tool.keyboard : ASSIST_KEYBOARD
          );
          return NextResponse.json({ status: 'ok' });
        }

        const rescheduleOptions = await getRescheduleOptions(chatId, estado.rescheduleId);

        const disponibilidad = await verificarDisponibilidad(
          estado.profesional!,
          estado.servicio!,
          estado.fecha!,
          horaSeleccionada,
          rescheduleOptions
        );

        if (disponibilidad.disponible) {
          await proceedAfterSlotChosen(
            chatId,
            estado,
            horaSeleccionada,
            saveState,
            sendWithKeyboard
          );
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
        const nombreOk = await resolvePatientNombre(chatId, estado);
        if (!nombreOk || !estado.fecha || !estado.hora || !estado.profesional || !estado.servicio) {
          if (estado.fecha && estado.hora && estado.profesional && estado.servicio) {
            await proceedAfterSlotChosen(
              chatId,
              estado,
              estado.hora,
              saveState,
              sendWithKeyboard
            );
          } else {
            await sendWithKeyboard(
              'Me faltan datos para confirmar. ¿Empezamos de nuevo?',
              ASSIST_KEYBOARD
            );
          }
          return NextResponse.json({ status: 'ok' });
        }

        // Verificar disponibilidad de nuevo (pudo ocuparse mientras confirmaba)
        const disponibilidad = await verificarDisponibilidad(estado.profesional!, estado.servicio!, estado.fecha!, estado.hora!);

        if (disponibilidad.disponible) {
          const datosReserva = {
            profesional: estado.profesional!,
            servicio: estado.servicio!,
            nombre: nombreOk,
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

      const showInfoResponse = async (infoType: InfoQueryType) => {
        if (infoType === 'obra_social') {
          await sendWithKeyboard(
            '🏥 *Obra social*\n\nEn este momento *no recibimos obra social*. La atención es *particular*.\n\nSi querés, puedo mostrarte servicios, horarios o ayudarte a reservar un turno.',
            ASSIST_KEYBOARD
          );
        } else if (infoType === 'horarios') {
          await sendWithKeyboard(await buildHorariosInfoMessage(), ASSIST_KEYBOARD);
        } else if (infoType === 'ubicacion') {
          await sendWithKeyboard(buildLocationMessage(), ASSIST_KEYBOARD);
        } else if (infoType === 'pago') {
          await sendWithKeyboard(buildFaqPagoMessage(), ASSIST_KEYBOARD);
        } else if (infoType === 'cancelacion') {
          await sendWithKeyboard(buildFaqCancelacionMessage(), ASSIST_KEYBOARD);
        } else if (infoType === 'que_traer') {
          await sendWithKeyboard(buildFaqQueTraerMessage(), ASSIST_KEYBOARD);
        } else if (infoType === 'estacionamiento') {
          await sendWithKeyboard(buildFaqEstacionamientoMessage(), ASSIST_KEYBOARD);
        } else if (infoType === 'duracion') {
          const servicios = await getServiciosList();
          await sendWithKeyboard(buildFaqDuracionMessage(servicios), ASSIST_KEYBOARD);
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

      const showHorarios = async (fechaStr: string, servicio?: string, profesional?: string) => {
        const serv = servicio || estado.servicio;
        const prof = profesional || estado.profesional;
        if (!serv || !prof) {
          await promptMissingProfOrServicio(
            { ...estado, fecha: fechaStr, servicio: serv, profesional: prof },
            saveState,
            sendWithKeyboard
          );
          return;
        }
        await saveState({
          paso: 'hora',
          servicio: serv,
          profesional: prof,
          nombre: estado.nombre,
          fecha: fechaStr,
          rescheduleId: estado.rescheduleId,
          clear: ['hora'],
        });
        const view = await buildHorariosView(fechaStr, serv, prof, estado.rescheduleId);
        await sendWithKeyboard(view.text, view.keyboard);
      };

      // Gemini puro: el texto siempre lo escribe el modelo. Botones = atajos (callbacks).
      const quickLocal = parseLocalIntent(text);

      // Menú / reset explícito → limpia draft + historial Gemini
      if (isExplicitMenuCommand(text)) {
        await clearState();
        await clearGeminiHistory(String(chatId));
        await showMainMenu();
        return NextResponse.json({ status: 'ok' });
      }

      // Saludo: reset solo si no hay reserva en curso (no perder draft mid-booking)
      let draftForAgent = estado || {};
      if (isGreetingOrChatReset(text)) {
        if (!estado?.paso) {
          await clearState();
          await clearGeminiHistory(String(chatId));
          estado = { paso: null };
          draftForAgent = {};
        }
      } else if (estado?.paso && isAbortBookingIntent(text) && !isMisReservasIntent(text)) {
        await clearState();
        await clearGeminiHistory(String(chatId));
        estado = { paso: null };
        draftForAgent = {};
      }

      // Texto libre → Gemini (prosa + tools). Callbacks de botones siguen en el branch de callback_query.
      // Fallbacks locales (servicio/profesional/confirm/fecha/hora) solo si viaLlm=false más abajo.

      const flowCtx = { saveState, sendWithKeyboard };

      // Gemini primero: interpreta prosa. Plantillas locales solo si el LLM falla.
      {
        const profile = await getUserProfile(chatId, kv);
        const history = await getChatHistory(chatId, kv);

        const assistantResult = await runAssistantTurn({
          userMessage: text,
          chatId,
          historyText: formatChatHistoryForPrompt(history),
          clinicContext: await buildClinicContextForAI(),
          draft: draftForAgent,
          profileSummary: profile
            ? `nombre=${profile.nombre || '-'}, ultimoTurno=${profile.lastProfesional || '-'}/${profile.lastServicio || '-'} (solo si pide repetir)`
            : undefined,
          handlers: makeAssistantHandlers(chatId),
        });

        if (
          await dispatchAssistantTurnResult(chatId, assistantResult, {
            saveState,
            sendWithKeyboard,
            clearState,
            draft: draftForAgent,
          })
        ) {
          // Si Gemini habló del nombre pero no llamó la tool, forzar persistencia
          const needsName =
            (draftForAgent?.paso === 'nombre' ||
              (draftForAgent?.hora &&
                draftForAgent?.fecha &&
                draftForAgent?.profesional &&
                draftForAgent?.servicio &&
                !sanitizePersonName(draftForAgent?.nombre))) &&
            extractPersonName(text) &&
            !assistantResult.usedTools.includes('set_patient_name');
          if (needsName) {
            await handleFlowNombreInput(chatId, { ...draftForAgent, paso: 'nombre' }, text, {
              saveState,
              sendWithKeyboard,
            });
          }
          return NextResponse.json({ status: 'ok' });
        }

        // Fallback solo si Gemini falló: no inventar prosa de plantilla
        // Mis reservas gana aunque haya draft a medias (no empujar "¿para qué día?")
        if (isMisReservasIntent(text) || quickLocal?.action === 'misreservas') {
          await showMisReservas(chatId, sendWithKeyboard, {
            mode: getMisReservasMode(text),
            saveState,
            userText: text,
          });
          return NextResponse.json({ status: 'ok' });
        }

        // FAQ / horario de atención: no empujar menú de servicios
        if (isClinicScheduleQuestion(text) || parseInfoQuery(text) === 'horarios') {
          await showInfoResponse('horarios');
          return NextResponse.json({ status: 'ok' });
        }

        // Solo cupos si pide turno NUEVO de forma clara (nunca por draft residual)
        const fechaHint = parseFecha(text);
        // Cupos solo con señal clara de RESERVAR. "mañana" en una FAQ de horarios NO cuenta.
        const infoQ = parseInfoQuery(text);
        const wantsCupos =
          !hasHeldBookingSlot(estado) &&
          estado?.paso !== 'confirmar' &&
          estado?.paso !== 'nombre' &&
          !isClinicScheduleQuestion(text) &&
          infoQ !== 'horarios' &&
          (looksLikeAvailabilityQuestion(text) ||
            containsBookingIntent(text) ||
            (Boolean(fechaHint) && !looksLikeQuestion(text)));

        if (wantsCupos) {
          await replyWithAvailabilityTool(chatId, {
            fecha: fechaHint || estado?.fecha || undefined,
            saveState,
            sendWithKeyboard,
          });
          return NextResponse.json({ status: 'ok' });
        }

        // Gemini falló mid-flow: saludo sin reset
        if (estado?.paso && isGreetingOrChatReset(text)) {
          const contextKeyboard = await getContextualKeyboard(estado);
          const resumeHint = estado.fecha
            ? `Seguimos con tu turno del *${formatDateAR(estado.fecha)}*${estado.hora ? ` a las *${estado.hora}*` : ''}.`
            : 'Seguimos con tu reserva cuando quieras.';
          await sendWithKeyboard(resumeHint, contextKeyboard);
          return NextResponse.json({ status: 'ok' });
        }

        // Gemini falló mid-flow: FAQ estática antes de pedir repetir
        if (estado?.paso && looksLikeQuestion(text)) {
          const consultaInfo = parseInfoQuery(text);
          if (consultaInfo) {
            await showInfoResponse(consultaInfo);
            return NextResponse.json({ status: 'ok' });
          }
        }

        // Gemini falló: pasos locales (fecha/hora/nombre/servicio/profesional/confirm) como red de seguridad
        if (estado?.paso === 'fecha' && isValidFlowInput(text, 'fecha')) {
          if (await handleFlowFechaInput(chatId, estado, text, flowCtx)) {
            return NextResponse.json({ status: 'ok' });
          }
        }
        if (estado?.paso === 'hora' && isValidFlowInput(text, 'hora')) {
          if (await handleFlowHoraInput(chatId, estado, text, flowCtx)) {
            return NextResponse.json({ status: 'ok' });
          }
        }

        if (estado?.paso === 'nombre') {
          if (await handleFlowNombreInput(chatId, estado, text, flowCtx)) {
            return NextResponse.json({ status: 'ok' });
          }
        }
        if (
          !sanitizePersonName(estado?.nombre) &&
          estado?.hora &&
          estado?.fecha &&
          estado?.profesional &&
          estado?.servicio &&
          estado.paso !== 'profesional' &&
          estado.paso !== 'servicio' &&
          estado.paso !== 'fecha' &&
          extractPersonName(text)
        ) {
          if (
            await handleFlowNombreInput(
              chatId,
              { ...estado, paso: 'nombre' },
              text,
              flowCtx
            )
          ) {
            return NextResponse.json({ status: 'ok' });
          }
        }

        if (
          estado?.paso === 'servicio' &&
          !looksLikeQuestion(text) &&
          !parseFecha(text) &&
          !looksLikeHoraInput(text)
        ) {
          const servicios = await getServiciosList();
          const servicioSeleccionado = matchServicioFromText(text, servicios);
          if (servicioSeleccionado) {
            await applyServicioSelection(
              chatId,
              estado,
              servicioSeleccionado,
              saveState,
              sendWithKeyboard
            );
            return NextResponse.json({ status: 'ok' });
          }
        }

        if (estado?.paso === 'profesional' && !looksLikeQuestion(text) && !parseFecha(text)) {
          const profesionales = await getProfesionales();
          const normalized = normalizeHumanText(text);
          let profSeleccionado: string | null = null;
          if (
            ['al azar', 'aleatorio', 'cualquiera', 'da igual', 'me da igual'].some(w =>
              normalized.includes(w)
            )
          ) {
            profSeleccionado =
              profesionales[Math.floor(Math.random() * profesionales.length)] || null;
          } else {
            const num = parseInt(text, 10);
            if (!isNaN(num) && num >= 1 && num <= profesionales.length) {
              profSeleccionado = profesionales[num - 1];
            } else {
              profSeleccionado = profesionales.find(p => matchesLoosely(p, text)) || null;
            }
          }
          if (profSeleccionado) {
            await continueAfterProfessional(
              chatId,
              estado,
              profSeleccionado,
              saveState,
              sendWithKeyboard,
              `*${profSeleccionado}* ✔️\n\n`
            );
            return NextResponse.json({ status: 'ok' });
          }
        }

        if (estado?.paso === 'confirmar' && estado.hora && estado.fecha) {
          const normalizedConfirm = normalizeHumanText(text);
          const confirmWords = [
            'si',
            'sí',
            'dale',
            'confirmar',
            'confirmo',
            'ok',
            'listo',
            'yes',
            'bueno',
            'va',
          ];
          const cancelWords = ['no', 'cancelar', 'cancel', 'nop', 'nope'];
          if (confirmWords.includes(normalizedConfirm)) {
            const nombreOk = await resolvePatientNombre(chatId, estado);
            if (!nombreOk) {
              await proceedAfterSlotChosen(
                chatId,
                estado,
                estado.hora!,
                saveState,
                sendWithKeyboard
              );
              return NextResponse.json({ status: 'ok' });
            }
            const rescheduleOptions = await getRescheduleOptions(chatId, estado.rescheduleId);
            const disponibilidad = await verificarDisponibilidad(
              estado.profesional!,
              estado.servicio!,
              estado.fecha!,
              estado.hora!,
              rescheduleOptions
            );
            if (disponibilidad.disponible) {
              if (estado.rescheduleId) {
                const reserva = await reprogramarReserva(
                  chatId,
                  estado.rescheduleId,
                  estado.fecha!,
                  estado.hora!
                );
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
                  nombre: nombreOk,
                  fecha: estado.fecha!,
                  hora: estado.hora!,
                  chatId,
                });
                if (reserva) {
                  await clearState();
                  const serv = await getServicio(reserva.servicio);
                  await sendWithKeyboard(
                    buildSuccessMessage(reserva, serv, false),
                    POST_BOOKING_KEYBOARD
                  );
                } else {
                  const viewActualizada = await buildHorariosView(
                    estado.fecha!,
                    estado.servicio!,
                    estado.profesional!
                  );
                  await sendWithKeyboard(
                    `⚠️ Ese horario acaba de ser reservado.\n\nElegí otro turno:`,
                    viewActualizada.keyboard
                  );
                }
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
            return NextResponse.json({ status: 'ok' });
          }
          if (cancelWords.includes(normalizedConfirm)) {
            await clearState();
            await sendWithKeyboard('Cancelado. ¿En qué más puedo ayudarte?', ASSIST_KEYBOARD);
            return NextResponse.json({ status: 'ok' });
          }
        }

        // Gemini falló mid-flow sin ser fecha/cupo: no tirar al menú de bienvenida
        if (estado?.paso) {
          const contextKeyboard = await getContextualKeyboard(estado);
          await sendWithKeyboard(
            'Disculpá, no pude procesar eso. ¿Me lo repetís? También podés usar los botones.',
            contextKeyboard
          );
          return NextResponse.json({ status: 'ok' });
        }
      }

      let aiResult = await resolveTextIntent(text, estado, chatId);

      if (aiResult.intent.action === 'consulta') {
        // Sin flujo: si Gemini falló, datos fijos de clínica (no inventar prosa)
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
            'Disculpá, no te entendí del todo. ¿Consultás horarios, precios, ubicación o querés un turno?',
            ASSIST_KEYBOARD
          );
        }
      } else if (
        // Con flujo activo NUNCA reiniciar reservar/servicios/etc (evita saltos)
        !estado?.paso &&
        aiResult.intent.action !== 'unknown'
      ) {
        if (aiResult.intent.action === 'menu') {
          await clearState();
          await showMainMenu();
        } else if (aiResult.intent.action === 'servicios') {
          await showServiciosCatalog();
        } else if (aiResult.intent.action === 'profesionales') {
          await showProfesionalesCatalog(isProfessionalsQuestion(text) ? 'info' : 'booking');
        } else if (aiResult.intent.action === 'misreservas') {
          await showMisReservas(chatId, sendWithKeyboard, {
            mode: getMisReservasMode(text),
            saveState,
            userText: text,
          });
        } else if (aiResult.intent.action === 'reservar') {
          const limitReached = await checkReservationLimit(chatId);
          if (limitReached) {
            await sendWithKeyboard(
              buildLimitReachedMessage(MAX_RESERVACIONES_POR_USUARIO),
              [[{ text: '📋 Mis reservas', callback_data: 'misreservas' }], [{ text: '🏠 Menú', callback_data: 'menu' }]]
            );
          } else {
            await replyWithAvailabilityTool(chatId, {
              fecha: parseFecha(text) || undefined,
              saveState,
              sendWithKeyboard,
            });
          }
        } else {
          await sendWithKeyboard(aiResult.responseText);
        }
      } else if (estado?.paso) {
        // Paso a paso: si el input no cierra el paso, el handler re-pregunta (sin saltar)
        console.log('Continuing with existing flow, estado:', estado);

        if (estado.paso === 'profesional') {
          const profesionales = await getProfesionales();
          const servicios = await getServiciosList();
          const normalized = normalizeHumanText(text);
          let profSeleccionado: string | null | undefined = null;

          // Si escribió un servicio en vez de profesional, tomarlo
          const servicioTyped = servicios.find(s => matchesLoosely(s.nombre, text))?.nombre;
          if (servicioTyped && !estado.servicio) {
            await saveState({ ...estado, paso: 'profesional', servicio: servicioTyped });
            await sendWithKeyboard(
              withFlowProgress(
                'profesional',
                `*${servicioTyped}* ✔️\n\n¿Con qué profesional te querés atender?`
              ),
              await buildProfesionalesKeyboard(servicioTyped)
            );
          } else {
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
              await continueAfterProfessional(
                chatId,
                estado,
                profSeleccionado,
                saveState,
                sendWithKeyboard,
                `*${profSeleccionado}* ✔️\n\n`
              );
            } else {
              await sendWithKeyboard(
                'Elegí un profesional de la lista:',
                await buildProfesionalesKeyboard(estado.servicio)
              );
            }
          }
        } else if (estado.paso === 'servicio') {
          const servicios = await getServiciosList();
          const servicioSeleccionado = matchServicioFromText(text, servicios);
          if (servicioSeleccionado) {
            await applyServicioSelection(
              chatId,
              estado,
              servicioSeleccionado,
              saveState,
              sendWithKeyboard
            );
          } else {
            await sendWithKeyboard(
              'No reconozco ese servicio. Por favor elegí uno:',
              await buildServiciosKeyboard(true)
            );
          }

        } else if (estado.paso === 'nombre') {
          await handleFlowNombreInput(chatId, estado, text, { saveState, sendWithKeyboard });

        } else if (estado.paso === 'fecha') {
          const fechaParseada = parseFecha(text);
          let esDiaValido = false;
          if (fechaParseada) {
            esDiaValido = await esDiaLaborable(fechaParseada, estado.profesional);
          }
          if (fechaParseada && esDiaValido) {
            await showHorarios(fechaParseada, estado.servicio!, estado.profesional!);
          } else if (fechaParseada && !esDiaValido) {
            const keyboard = await buildFechasKeyboard(estado.profesional, estado.servicio, estado.rescheduleId);
            await sendWithKeyboard(
              '❌ El profesional no atiende ese día. Elegí otro:',
              keyboard
            );
          } else {
            const view = await buildFechasView(estado.servicio, estado.profesional);
            await sendWithKeyboard('No pude interpretar esa fecha. Elegí un día de la lista:', view.keyboard);
          }

        } else if (estado.paso === 'hora') {
          // "mañana 19" / "el lunes" = cambiar FECHA, no filtrar franja "mañana"
          const fechaNueva = parseFecha(text);
          if (fechaNueva && fechaNueva !== estado.fecha) {
            const laborable = await esDiaLaborable(fechaNueva, estado.profesional);
            if (!laborable) {
              const keyboard = await buildFechasKeyboard(
                estado.profesional,
                estado.servicio,
                estado.rescheduleId
              );
              await sendWithKeyboard(
                `Ese día (*${formatDateAR(fechaNueva)}*) no hay agenda con *${estado.profesional}*. Elegí otra fecha:`,
                keyboard
              );
              return NextResponse.json({ status: 'ok' });
            }
            await showHorarios(fechaNueva, estado.servicio!, estado.profesional!);
            return NextResponse.json({ status: 'ok' });
          }

          const horariosLibres = await obtenerHorariosLibres(
            estado.fecha!,
            estado.profesional!,
            estado.servicio!,
            estado.rescheduleId
          );
          let horaSeleccionada: string | null = null;

          // Franja solo con "por la mañana / a la tarde" (no "mañana" = día)
          const normalizedPeriod = normalizeHumanText(text);
          const morningPref =
            /por\s+la\s+manana|a\s+la\s+manana|de\s+manana|x\s+la\s+manana/.test(normalizedPeriod);
          const afternoonPref =
            /por\s+la\s+tarde|a\s+la\s+tarde|de\s+tarde|x\s+la\s+tarde/.test(normalizedPeriod);
          const wantsMorning = morningPref;
          const wantsAfternoon =
            afternoonPref ||
            (/\btarde\b/.test(normalizedPeriod) && !parseFecha(text) && !morningPref);
          const mentionsConcreteTime = extractHoraCandidates(text).length > 0;

          if ((wantsMorning || wantsAfternoon) && !mentionsConcreteTime) {
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

          const parsedHora = parseHoraSelection(text, horariosLibres);

          if (parsedHora.status === 'ambiguous') {
            const keyboard: any[] = [];
            for (let i = 0; i < parsedHora.candidates.length; i += 3) {
              keyboard.push(
                parsedHora.candidates.slice(i, i + 3).map(h => ({
                  text: `🕐 ${h}`,
                  callback_data: `hora:${h}`,
                }))
              );
            }
            keyboard.push([{ text: '📅 Ver todos', callback_data: 'refresh_horarios' }, BTN.MENU]);
            await sendWithKeyboard(
              withFlowProgress(
                'hora',
                `Vi más de un horario (*${parsedHora.candidates.join('*, *')}*). ¿Cuál preferís?`
              ),
              keyboard
            );
            return NextResponse.json({ status: 'ok' });
          }

          if (parsedHora.status === 'matched') {
            horaSeleccionada = parsedHora.hora;
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
              await proceedAfterSlotChosen(
                chatId,
                estado,
                horaSeleccionada,
                saveState,
                sendWithKeyboard
              );
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
            const view = await buildHorariosView(
              estado.fecha!,
              estado.servicio!,
              estado.profesional!,
              estado.rescheduleId
            );
            await sendWithKeyboard(
              'No pude interpretar ese horario. Tocá uno de la lista o escribí por ejemplo *15:30*:',
              view.keyboard
            );
          }

        } else if (estado.paso === 'confirmar') {
          const normalizedConfirm = normalizeHumanText(text);
          const confirmWords = ['si', 'sí', 'dale', 'confirmar', 'confirmo', 'ok', 'listo', 'yes', 'bueno', 'va'];
          const cancelWords = ['no', 'cancelar', 'cancel', 'nop', 'nope'];

          if (confirmWords.includes(normalizedConfirm)) {
            const nombreOk = await resolvePatientNombre(chatId, estado);
            if (!nombreOk) {
              await proceedAfterSlotChosen(
                chatId,
                estado,
                estado.hora!,
                saveState,
                sendWithKeyboard
              );
              return NextResponse.json({ status: 'ok' });
            }
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
                  nombre: nombreOk,
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
        } else if (looksLikeAvailabilityQuestion(text) || parseFecha(text)) {
          // Solo menú de cupos con señal clara; si no, respetá la prosa del modelo
          await replyWithAvailabilityTool(chatId, {
            fecha: parseFecha(text) || undefined,
            saveState,
            sendWithKeyboard,
          });
        } else {
          await clearState();
          await sendWithKeyboard(aiResult.responseText, ASSIST_KEYBOARD);
        }
      } else if (estado?.paso) {
        const contextKeyboard = await getContextualKeyboard(estado);
        await sendWithKeyboard(
          'No te entendí del todo. ¿Me lo aclarás? También podés usar los botones.',
          contextKeyboard
        );
      } else {
        // Nunca resetear al menú de bienvenida por un mensaje no reconocido
        const fechaOrphan = parseFecha(text);
        if (fechaOrphan) {
          await replyWithAvailabilityTool(chatId, {
            fecha: fechaOrphan,
            saveState,
            sendWithKeyboard,
          });
        } else {
          await sendWithKeyboard(
            'No te entendí del todo. ¿Querés un turno, ver servicios o consultar algo de la clínica?',
            ASSIST_KEYBOARD
          );
        }
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
