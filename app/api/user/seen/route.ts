import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { pool } from '@/lib/db';

// Mark a channel as seen
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { channelId } = await req.json();
  if (!channelId) {
    return NextResponse.json({ error: 'channelId required' }, { status: 400 });
  }

  await pool.query(
    `INSERT INTO user_seen_channels (user_id, channel_id)
     VALUES ($1, $2)
     ON CONFLICT (user_id, channel_id) DO NOTHING`,
    [session.user.id, channelId]
  );

  return NextResponse.json({ ok: true });
}
