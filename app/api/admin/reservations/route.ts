import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@vercel/kv';
import { isAuthenticated } from '@/lib/auth';

interface Reservation {
  id: string;
  servicio: string;
  nombre: string;
  fecha: string;
  hora: string;
  chatId: number;
}

// Almacenamiento en memoria para desarrollo local
const localReservations: Reservation[] = [];

export function getLocalReservations() {
  return localReservations;
}

export function addLocalReservation(reservation: Reservation) {
  localReservations.push(reservation);
}

function getKV() {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return createClient({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
  }
  return null;
}

export async function GET(request: NextRequest) {
  // Verificar autenticación
  const authenticated = await isAuthenticated();
  if (!authenticated) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  try {
    const kv = getKV();
    if (!kv) {
      return NextResponse.json({ reservations: localReservations });
    }

    const keys = await kv.keys('reserva:id:*');
    const reservations: Reservation[] = [];

    for (const key of keys) {
      const value = await kv.get(key);
      if (value) {
        const reservation = typeof value === 'string' ? JSON.parse(value) : value;
        reservations.push(reservation);
      }
    }

    // Ordenar por fecha y hora
    reservations.sort((a, b) => {
      const dateA = `${a.fecha} ${a.hora}`;
      const dateB = `${b.fecha} ${b.hora}`;
      return dateA.localeCompare(dateB);
    });

    return NextResponse.json({ reservations });
  } catch (error) {
    console.error('Error fetching reservations:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  // Verificar autenticación antes de eliminar
  const authenticated = await isAuthenticated();
  if (!authenticated) {
    return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  }

  try {
    const { id } = await request.json();

    if (!id) {
      return NextResponse.json({ error: 'ID is required' }, { status: 400 });
    }

    const kv = getKV();
    if (!kv) {
      const index = localReservations.findIndex(r => r.id === id);
      if (index !== -1) {
        localReservations.splice(index, 1);
      }
      return NextResponse.json({ success: true });
    }

    // Obtener la reserva primero para conocer fecha y hora
    const idKey = `reserva:id:${id}`;
    const reservaData = await kv.get(idKey);
    if (!reservaData) {
      return NextResponse.json({ error: 'Reservation not found' }, { status: 404 });
    }

    const reserva = typeof reservaData === 'string' ? JSON.parse(reservaData) : reservaData;

    // Eliminar todas las referencias
    const key = `reserva:${reserva.servicio}:${reserva.fecha}:${reserva.hora}`;
    await kv.del(key);
    await kv.del(idKey);

    // Eliminar de la lista del usuario
    const userKey = `user:${reserva.chatId}:reservas`;
    const userReservas = await kv.get(userKey) || [];
    let reservasArray = Array.isArray(userReservas) ? userReservas : JSON.parse(userReservas as string);
    reservasArray = reservasArray.filter((r: Reservation) => r.id !== id);
    await kv.set(userKey, JSON.stringify(reservasArray));

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error deleting reservation:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
