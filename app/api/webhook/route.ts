import { NextRequest, NextResponse } from 'next/server';
import axios from 'axios';
import { createClient } from '@vercel/kv';
import { getLocalReservations, addLocalReservation } from '../admin/reservations/route';
import { GoogleGenerativeAI } from '@google/generative-ai';

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
    const reservaServicio = await getServicio(reserva.servicio);
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

    // Check if it's a holiday
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

// Gemini Integration
interface GeminiIntent {
  action: 'menu' | 'reservar' | 'misreservas' | 'servicios' | 'profesionales' | 'unknown';
  parameters?: {
    profesional?: string;
    servicio?: string;
    fecha?: string;
    nombre?: string;
  };
}

async function getGeminiResponse(userMessage: string, estado: ConversationState): Promise<{
  responseText: string;
  intent: GeminiIntent;
  shouldContinueWithFlow: boolean;
}> {
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    return {
      responseText: "Lo siento, no puedo procesar tu mensaje en este momento. Por favor usá los botones.",
      intent: { action: 'unknown' },
      shouldContinueWithFlow: false
    };
  }

  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const config = await getConfig();
  const serviciosList = config.servicios.map(s => s.nombre).join(', ');
  const profesionalesList = Object.keys(config.profesionales).join(', ');

  const systemPrompt = `
Eres un asistente amigable para reservar turnos en una clínica de quiropraxia y masajes.
Tu trabajo es entender el mensaje del usuario y responder apropiadamente, y también identificar la intención del usuario.

Contexto de la clínica:
- Profesionales disponibles: ${profesionalesList}
- Servicios disponibles: ${serviciosList}
- Atención particular, no se recibe obra social.

Responde en español, de forma concisa y amigable.

Formato de respuesta JSON (escribe solo el JSON, sin texto adicional):
{
  "responseText": "tu respuesta al usuario",
  "intent": {
    "action": "menu" | "reservar" | "misreservas" | "servicios" | "profesionales" | "unknown",
    "parameters": {
      "profesional": "nombre del profesional si el usuario lo mencionó",
      "servicio": "nombre del servicio si el usuario lo mencionó",
      "fecha": "fecha en formato YYYY-MM-DD si el usuario lo mencionó, o null",
      "nombre": "nombre del usuario si lo mencionó"
    }
  },
  "shouldContinueWithFlow": true/false (true si el usuario está en un flujo de reserva y debemos continuar, false si debemos responder con el texto)
}
`;

  const chatHistory = estado ? `
Estado de la conversación:
- Paso actual: ${estado.paso}
- Profesional: ${estado.profesional}
- Servicio: ${estado.servicio}
- Nombre: ${estado.nombre}
- Fecha: ${estado.fecha}
- Hora: ${estado.hora}
` : '';

  const prompt = `${systemPrompt}\n\n${chatHistory}\n\nMensaje del usuario: ${userMessage}`;

  try {
    const result = await model.generateContent(prompt);
    const response = result.response;
    const text = response.text();
    
    // Clean the response (remove markdown code blocks if present)
    const cleanedText = text.replace(/```json|```/g, '').trim();
    
    try {
      const parsed = JSON.parse(cleanedText);
      return parsed;
    } catch (jsonError) {
      return {
        responseText: text,
        intent: { action: 'unknown' },
        shouldContinueWithFlow: false
      };
    }
  } catch (error) {
    console.error('Error with Gemini:', error);
    return {
      responseText: "Lo siento, no puedo procesar tu mensaje en este momento. Por favor usá los botones.",
      intent: { action: 'unknown' },
      shouldContinueWithFlow: false
    };
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
        const servicios = await getServiciosList();
        await saveState({ paso: 'servicio', profesional: profSeleccionado });
        await sendWithKeyboard(
          `*${profSeleccionado}* ✔️\n\n¿Qué servicio querés reservar?`,
          servicios.map(s => [{ text: s.nombre, callback_data: `servicio:${s.nombre}` }])
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
        const view = await buildFechasView(estado.servicio, estado.profesional);
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
          const view = await buildConfirmacionView({ ...estado, hora: horaSeleccionada });
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
        const servicios = await getServiciosList();
        await sendWithKeyboard(
          '🩺 *Servicios disponibles:*\n\n*(Atención particular, sin obra social)*',
          servicios.map(s => [{ text: `${s.nombre} ($${s.precio})`, callback_data: 'noop' }])
        );
      };

      const showHorarios = async (fechaStr: string, servicio: string, profesional: string) => {
        await saveState({ ...estado, paso: 'hora', servicio, nombre: estado.nombre, fecha: fechaStr, profesional });
        const view = await buildHorariosView(fechaStr, servicio, profesional);
        await sendWithKeyboard(view.text, view.keyboard);
      };

      // Try Gemini first
      const geminiResult = await getGeminiResponse(text, estado);
      
      // If we have an intent, handle it
      if (geminiResult.intent.action !== 'unknown' && !geminiResult.shouldContinueWithFlow) {
        if (geminiResult.intent.action === 'menu') {
          await clearState();
          await showMainMenu();
        } else if (geminiResult.intent.action === 'servicios') {
          await showServices();
        } else if (geminiResult.intent.action === 'profesionales') {
          const profesionales = await getProfesionales();
          await sendWithKeyboard(
            '👨‍⚕️ *Nuestros profesionales:*\n\n*(Atención particular, sin obra social)*',
            profesionales.map(p => [{ text: p, callback_data: `profesional:${p}` }])
          );
        } else if (geminiResult.intent.action === 'misreservas') {
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
            const keyboard = reservasArray.map((r: Reservation) => [
              { text: `${r.servicio} — ${formatDate(r.fecha)} ${r.hora}`, callback_data: 'noop' },
              { text: '❌ Eliminar', callback_data: `eliminar:${r.id}` }
            ]);
            keyboard.push([{ text: '🏠 Menú', callback_data: 'menu' }]);
            await sendWithKeyboard('📋 *Tus reservas:*', keyboard);
          }
        } else if (geminiResult.intent.action === 'reservar') {
          const limitReached = await checkReservationLimit(chatId);
          if (limitReached) {
            await sendWithKeyboard(
              '⚠️ *Límite de reservas alcanzado*\n\nYa tenés el máximo de turnos activos permitidos. Para reservar uno nuevo, primero tenés que cancelar alguno desde tus reservas.',
              [[{ text: '📋 Mis reservas', callback_data: 'misreservas' }], [{ text: '🏠 Menú', callback_data: 'menu' }]]
            );
          } else {
            const profesionales = await getProfesionales();
            
            // Check if intent has parameters
            let newEstado: ConversationState = { paso: 'profesional' };
            
            if (geminiResult.intent.parameters?.profesional) {
              // Find the professional
              const prof = profesionales.find(p => 
                p.toLowerCase().includes(geminiResult.intent.parameters!.profesional!.toLowerCase())
              );
              if (prof) {
                newEstado.profesional = prof;
                newEstado.paso = 'servicio';
              }
            }
            
            if (geminiResult.intent.parameters?.servicio) {
              const servicios = await getServiciosList();
              const serv = servicios.find(s => 
                s.nombre.toLowerCase().includes(geminiResult.intent.parameters!.servicio!.toLowerCase())
              );
              if (serv) {
                newEstado.servicio = serv.nombre;
                if (newEstado.paso === 'servicio') {
                  newEstado.paso = 'nombre';
                }
              }
            }
            
            if (geminiResult.intent.parameters?.nombre) {
              newEstado.nombre = geminiResult.intent.parameters.nombre;
              if (newEstado.paso === 'nombre') {
                newEstado.paso = 'fecha';
              }
            }
            
            if (geminiResult.intent.parameters?.fecha) {
              newEstado.fecha = geminiResult.intent.parameters.fecha;
              if (newEstado.paso === 'fecha' && newEstado.profesional && newEstado.servicio) {
                newEstado.paso = 'hora';
              }
            }
            
            await saveState(newEstado);
            
            // Now show the appropriate view
            if (newEstado.paso === 'profesional') {
              await sendWithKeyboard(
                '¿Con qué profesional te querés atender?',
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
          await sendWithKeyboard(geminiResult.responseText);
        }
      } else if (geminiResult.shouldContinueWithFlow && estado && estado.paso) {
        // Continue with the existing flow
        console.log('Continuing with existing flow, estado:', estado);

        if (estado.paso === 'profesional') {
          const profesionales = await getProfesionales();
          let profSeleccionado = null;
          const num = parseInt(text);
          if (!isNaN(num) && num >= 1 && num <= profesionales.length) {
            profSeleccionado = profesionales[num - 1];
          } else {
            profSeleccionado = profesionales.find(p => p.toLowerCase().includes(text.toLowerCase()));
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
            servicioSeleccionado = servicios.find(s => s.nombre.toLowerCase().includes(text.toLowerCase()))?.nombre;
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
              const view = await buildConfirmacionView({ ...estado, hora: horaSeleccionada });
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
          const view = await buildConfirmacionView(estado);
          await sendWithKeyboard('Por favor usá los botones para confirmar o cancelar:\n\n' + view.text, view.keyboard);
        }
      } else {
        // Fallback to original flow or show Gemini response
        if (geminiResult.responseText) {
          await sendWithKeyboard(geminiResult.responseText);
        } else {
          await showMainMenu();
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
