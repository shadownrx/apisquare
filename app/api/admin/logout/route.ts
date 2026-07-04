import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { createClient } from '@vercel/kv';

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  const token = cookieStore.get('admin_session')?.value;

  // Invalidar token en KV
  if (token && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const kv = createClient({
        url: process.env.KV_REST_API_URL,
        token: process.env.KV_REST_API_TOKEN,
      });
      await kv.del(`session:${token}`);
    } catch { /* ignorar errores al cerrar sesión */ }
  }

  cookieStore.delete('admin_session');
  // También borrar cookie antigua por compatibilidad
  cookieStore.delete('admin_authenticated');

  return NextResponse.redirect(new URL('/login', request.url));
}
