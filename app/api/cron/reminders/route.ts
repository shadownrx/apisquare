import { NextRequest, NextResponse } from 'next/server';
import { processReminders } from '@/lib/reminders';

function isAuthorized(request: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (!cronSecret) {
    console.error('[cron/reminders] CRON_SECRET is not configured');
    return false;
  }

  const authHeader = request.headers.get('authorization');
  if (authHeader === `Bearer ${cronSecret}`) return true;

  const querySecret = request.nextUrl.searchParams.get('secret');
  if (querySecret === cronSecret) return true;

  return false;
}

async function runCron() {
  const result = await processReminders();
  return NextResponse.json({ status: 'ok', ...result });
}

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    return await runCron();
  } catch (error) {
    console.error('Error processing reminders:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    return await runCron();
  } catch (error) {
    console.error('Error processing reminders:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
