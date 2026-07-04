import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: 'Bot de reservas está activo!',
    timestamp: new Date().toISOString()
  });
}
