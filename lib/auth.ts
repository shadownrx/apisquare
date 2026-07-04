import { cookies } from 'next/headers';
import { createClient } from '@vercel/kv';

// Variable global para persistir las sesiones en memoria local durante el desarrollo de Next.js
const globalSessions = (global as any)._localSessions || new Set<string>();
if (!(global as any)._localSessions) {
  (global as any)._localSessions = globalSessions;
}

export function addLocalSession(token: string) {
  globalSessions.add(token);
}

export function removeLocalSession(token: string) {
  globalSessions.delete(token);
}

export async function isAuthenticated(): Promise<boolean> {
  const cookieStore = await cookies();
  const token = cookieStore.get('admin_session')?.value;

  if (!token) return false;

  // Si el token está registrado en la memoria local (desarrollo), lo damos por válido
  if (globalSessions.has(token)) {
    return true;
  }

  // Si hay KV, validar el token contra la BD (producción)
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

  // Fallback de desarrollo para cualquier token válido
  return token.length === 64;
}
