import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';

// Función simple para verificar credenciales
async function verifyCredentials(username: string, password: string): Promise<boolean> {
  const validUsername = process.env.ADMIN_USERNAME || 'admin';
  const validPassword = process.env.ADMIN_PASSWORD || 'password123';
  
  return username === validUsername && password === validPassword;
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { username, password } = body;

  if (await verifyCredentials(username, password)) {
    // Establecer una cookie simple (no segura para producción, pero funcional)
    const cookieStore = await cookies();
    cookieStore.set('admin_authenticated', 'true', {
      path: '/',
      maxAge: 60 * 60 * 24 * 7, // 1 semana
    });
    
    return NextResponse.json({ success: true });
  }

  return NextResponse.json({ error: 'Credenciales incorrectas' }, { status: 401 });
}
