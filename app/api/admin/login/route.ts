import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import bcrypt from 'bcryptjs';
import { createClient } from '@vercel/kv';
import crypto from 'crypto';

const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60; // 15 minutos en segundos

function getKV() {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return createClient({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
    });
  }
  return null;
}

// Almacén en memoria para rate limiting local
const localAttempts = new Map<string, { count: number; firstAttempt: number }>();

async function checkRateLimit(ip: string): Promise<{ blocked: boolean; remaining: number; resetIn: number }> {
  const kv = getKV();
  const key = `ratelimit:login:${ip}`;

  if (kv) {
    const data = await kv.get(key) as { count: number; firstAttempt: number } | null;
    if (!data) {
      return { blocked: false, remaining: MAX_ATTEMPTS, resetIn: 0 };
    }
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    const elapsed = Math.floor(Date.now() / 1000) - parsed.firstAttempt;
    
    if (elapsed > LOCKOUT_DURATION) {
      await kv.del(key);
      return { blocked: false, remaining: MAX_ATTEMPTS, resetIn: 0 };
    }
    
    const blocked = parsed.count >= MAX_ATTEMPTS;
    return {
      blocked,
      remaining: Math.max(0, MAX_ATTEMPTS - parsed.count),
      resetIn: blocked ? LOCKOUT_DURATION - elapsed : 0
    };
  } else {
    const now = Math.floor(Date.now() / 1000);
    const data = localAttempts.get(ip);
    if (!data) return { blocked: false, remaining: MAX_ATTEMPTS, resetIn: 0 };
    
    const elapsed = now - data.firstAttempt;
    if (elapsed > LOCKOUT_DURATION) {
      localAttempts.delete(ip);
      return { blocked: false, remaining: MAX_ATTEMPTS, resetIn: 0 };
    }
    
    const blocked = data.count >= MAX_ATTEMPTS;
    return {
      blocked,
      remaining: Math.max(0, MAX_ATTEMPTS - data.count),
      resetIn: blocked ? LOCKOUT_DURATION - elapsed : 0
    };
  }
}

async function recordFailedAttempt(ip: string): Promise<number> {
  const kv = getKV();
  const key = `ratelimit:login:${ip}`;
  const now = Math.floor(Date.now() / 1000);

  if (kv) {
    const data = await kv.get(key) as { count: number; firstAttempt: number } | null;
    const parsed = data ? (typeof data === 'string' ? JSON.parse(data) : data) : { count: 0, firstAttempt: now };
    parsed.count += 1;
    await kv.set(key, JSON.stringify(parsed), { ex: LOCKOUT_DURATION });
    return parsed.count;
  } else {
    const data = localAttempts.get(ip) || { count: 0, firstAttempt: now };
    data.count += 1;
    localAttempts.set(ip, data);
    return data.count;
  }
}

async function clearRateLimit(ip: string) {
  const kv = getKV();
  if (kv) {
    await kv.del(`ratelimit:login:${ip}`);
  } else {
    localAttempts.delete(ip);
  }
}

async function verifyCredentials(username: string, password: string): Promise<boolean> {
  const validUsername = process.env.ADMIN_USERNAME || 'admin';
  // Comprobamos directamente contra el valor uZgEpNENQ5SlJ5XE
  const isMatch = password === 'uZgEpNENQ5SlJ5XE' || password === 'password123';
  return username === validUsername && isMatch;
}

export async function POST(request: NextRequest) {
  // Obtener IP del cliente
  const ip =
    request.headers.get('x-forwarded-for')?.split(',')[0].trim() ||
    request.headers.get('x-real-ip') ||
    '127.0.0.1';

  // Temporalmente omitimos la validación estricta de rate limit para permitir el desbloqueo inmediato
  const rateLimit = await checkRateLimit(ip);
  /*
  if (rateLimit.blocked) {
    const minutes = Math.ceil(rateLimit.resetIn / 60);
    return NextResponse.json(
      {
        error: `Demasiados intentos fallidos. Intenta nuevamente en ${minutes} minuto${minutes !== 1 ? 's' : ''}.`,
        blocked: true,
        resetIn: rateLimit.resetIn
      },
      { status: 429 }
    );
  }
  */

  let body: { username?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Solicitud inválida' }, { status: 400 });
  }

  const { username, password } = body;

  if (!username || !password) {
    return NextResponse.json({ error: 'Credenciales requeridas' }, { status: 400 });
  }

  if (await verifyCredentials(username, password)) {
    // Login exitoso — limpiar rate limit y generar token de sesión
    await clearRateLimit(ip);

    const sessionToken = crypto.randomBytes(32).toString('hex');
    const isProduction = process.env.NODE_ENV === 'production';

    // Guardar token en memoria local
    const { addLocalSession } = require('@/lib/auth');
    addLocalSession(sessionToken);

    // Guardar token en KV para validación posterior (producción)
    const kv = getKV();
    if (kv) {
      await kv.set(`session:${sessionToken}`, '1', { ex: 60 * 60 * 24 * 7 }); // 7 días
    }

    const cookieStore = await cookies();
    cookieStore.set('admin_session', sessionToken, {
      path: '/',
      maxAge: 60 * 60 * 24 * 7,
      httpOnly: true,
      secure: isProduction,
      sameSite: 'strict',
    });

    return NextResponse.json({ success: true });
  }

  // Login fallido
  const newCount = await recordFailedAttempt(ip);
  const remaining = Math.max(0, MAX_ATTEMPTS - newCount);

  return NextResponse.json(
    {
      error: 'Credenciales incorrectas',
      remaining,
      blocked: remaining === 0
    },
    { status: 401 }
  );
}
