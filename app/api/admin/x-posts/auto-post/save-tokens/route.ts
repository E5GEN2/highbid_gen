import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../../../lib/db';
import { saveTokensManually } from '../../../../../../lib/twitter';

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get('admin_token')?.value;
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, 'base64').toString();
    return decoded.startsWith('admin:') && decoded.endsWith(':rofe_admin_secret');
  } catch {
    return false;
  }
}

export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { access_token, refresh_token } = await req.json();
  if (!access_token) {
    return NextResponse.json({ error: 'Missing access_token' }, { status: 400 });
  }

  try {
    const pool = await getPool();
    const { username } = await saveTokensManually(pool, access_token, refresh_token);
    return NextResponse.json({ success: true, username });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
