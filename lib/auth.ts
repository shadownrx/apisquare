import { cookies } from 'next/headers';
import { createClient } from '@vercel/kv';

// Tokens de sesión en memoria para desarrollo local
const localSessions = new Set<string>();

export function addLocalSession(token: string) {
  localSessions.add(token);
}

export async function isAuthenticated(): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get('admin_session')?.value;

  if (!token) return false;

  // Si hay KV, validar el token contra la BD
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    try {
      const kv = createClient({
        url: process.env.KV_REST_API_URL,
        token: process.env.KV_REST_API_TOKEN,
      });
      const valid = await kv.get(`session:${token}`);
      return valid === '1';
    } catch {
      return false;
    }
  }

  // Fallback para desarrollo: aceptar cualquier token no vacío
  return token.length === 64;
}
