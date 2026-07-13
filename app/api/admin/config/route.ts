import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@vercel/kv';
import { isAuthenticated } from '@/lib/auth';

// Interfaces
interface TimeSlot {
  inicio: string;
  fin: string;
}

interface ProfessionalSchedule {
  [day: number]: TimeSlot[]; // day: 0 = domingo, 1 = lunes, ..., 6 = sábado
}

interface Config {
  profesionales: {
    [name: string]: ProfessionalSchedule;
  };
  feriados: string[]; // array de fechas en formato YYYY-MM-DD
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

const KV_KEY = 'app:config';

function getKV() {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return createClient({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
  }
  return null;
}

// Local storage for development (server-side global)
const globalConfig = (global as any)._localAppConfig || DEFAULT_CONFIG;
if (!(global as any)._localAppConfig) {
  (global as any)._localAppConfig = globalConfig;
}

const getLocalConfig = (): Config => {
  return (global as any)._localAppConfig || DEFAULT_CONFIG;
};
const setLocalConfig = (config: Config) => {
  (global as any)._localAppConfig = config;
};

export async function GET(request: NextRequest) {
  // Verify auth
  const authenticated = await isAuthenticated();
  if (!authenticated) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  try {
    const kv = getKV();
    let config: Config;
    if (kv) {
      const stored = await kv.get(KV_KEY);
      config = stored ? (typeof stored === 'string' ? JSON.parse(stored) : stored) : DEFAULT_CONFIG;
    } else {
      config = getLocalConfig();
    }

    // Merge with default to ensure all fields exist (horarios por día)
    const readDaySlots = (
      schedule: ProfessionalSchedule | undefined,
      dia: number
    ): TimeSlot[] | undefined => {
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
    };

    const mergeSchedules = (
      defaults: Config['profesionales'],
      stored?: Config['profesionales']
    ): Config['profesionales'] => {
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
            daySchedule[dia] = fromBase;
          } else if (fromOverlay) {
            daySchedule[dia] = fromOverlay;
          }
        }
        merged[name] = daySchedule;
      }
      return merged;
    };

    config = {
      ...DEFAULT_CONFIG,
      ...config,
      profesionales: mergeSchedules(DEFAULT_CONFIG.profesionales, config.profesionales),
      servicios: config.servicios && config.servicios.length > 0 ? config.servicios : DEFAULT_CONFIG.servicios
    };

    config.servicios = config.servicios.map(s => ({
      ...s,
      nombre: s.nombre.replace(/Quiropráctica/gi, 'Quiropraxia').replace(/quiropractica/gi, 'Quiropraxia')
    }));

    return NextResponse.json({ config });
  } catch (error) {
    console.error('Error al obtener configuración:', error);
    return NextResponse.json({ error: 'Error interno' }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  // Verify auth
  const authenticated = await isAuthenticated();
  if (!authenticated) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  try {
    const newConfig = await request.json();

    // Validate basic structure
    if (!newConfig.profesionales || !Array.isArray(newConfig.feriados) || !Array.isArray(newConfig.servicios)) {
      return NextResponse.json({ error: 'Estructura de configuración inválida' }, { status: 400 });
    }

    const kv = getKV();
    if (kv) {
      await kv.set(KV_KEY, JSON.stringify(newConfig));
    } else {
      setLocalConfig(newConfig);
    }

    return NextResponse.json({ success: true, config: newConfig });
  } catch (error) {
    console.error('Error al guardar configuración:', error);
    return NextResponse.json({ error: 'Error interno' }, { status: 500 });
  }
}
