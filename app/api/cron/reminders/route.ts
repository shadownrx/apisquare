import { NextRequest, NextResponse } from 'next/server';
import { processReminders } from '@/lib/reminders';

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET?.trim();

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await processReminders();
    return NextResponse.json({ status: 'ok', ...result });
  } catch (error) {
    console.error('Error processing reminders:', error);
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
