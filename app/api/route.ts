import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({
    status: "ok",
    message: "Bot de reservas Square está activo!",
    endpoints: {
      webhook: "/api/webhook",
      healthcheck: "/api/healthcheck"
    }
  });
}
