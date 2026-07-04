import { NextResponse } from 'next/server';
import { createClient } from '@vercel/kv';

let kv: any = null;

try {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    kv = createClient({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
  }
} catch (e) {
  console.log('KV not available locally');
}

// Almacenamiento en memoria compartido (solo para desarrollo)
// Nota: Esto no es óptimo, pero funciona para pruebas locales
const globalLocalReservations: any[] = [
  { servicio: 'Sesión de Quiropráctica', nombre: 'Juan Pérez', fecha: '2026-07-10', hora: '09:00', chatId: 12345 },
  { servicio: 'Masaje Relajante', nombre: 'María Gómez', fecha: '2026-07-11', hora: '10:00', chatId: 67890 }
];

// Función para acceder a las reservas locales (compartida entre rutas)
export function getLocalReservations() {
  return globalLocalReservations;
}

export function addLocalReservation(reservation: any) {
  globalLocalReservations.push(reservation);
}

export async function GET() {
  try {
    // Si KV está disponible, usarla
    if (kv) {
      // Obtener todas las claves de reservas
      const keys = await kv.keys('reserva:*');
      const reservations = [];

      for (const key of keys) {
        const value = await kv.get(key);
        if (value) {
          const reservation = typeof value === 'string' ? JSON.parse(value) : value;
          reservations.push(reservation);
        }
      }

      return NextResponse.json({ reservations });
    } else {
      // Si no, usar datos de ejemplo para desarrollo
      console.log('Using local reservations for local development');
      return NextResponse.json({ reservations: globalLocalReservations });
    }
  } catch (error) {
    console.error('Error fetching reservations:', error);
    // En caso de error, también usar datos de ejemplo
    return NextResponse.json({ reservations: globalLocalReservations });
  }
}
