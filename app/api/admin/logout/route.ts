import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';

export async function POST(request: NextRequest) {
  const cookieStore = await cookies();
  cookieStore.delete('admin_authenticated');
  
  return NextResponse.redirect(new URL('/', request.url));
}
