import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { pool } from '@/lib/db';

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await pool.query(
    `SELECT feed_filters, hidden_channel_ids FROM user_preferences WHERE user_id = $1`,
    [session.user.id]
  );

  if (result.rows.length === 0) {
    return NextResponse.json({ feedFilters: {}, hiddenChannelIds: [] });
  }

  const row = result.rows[0];
  return NextResponse.json({
    feedFilters: row.feed_filters ?? {},
    hiddenChannelIds: row.hidden_channel_ids ?? [],
  });
}

export async function PUT(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body = await request.json();
  const { feedFilters, hiddenChannelIds } = body;

  await pool.query(
    `INSERT INTO user_preferences (user_id, feed_filters, hidden_channel_ids, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       feed_filters = COALESCE($2, user_preferences.feed_filters),
       hidden_channel_ids = COALESCE($3, user_preferences.hidden_channel_ids),
       updated_at = NOW()`,
    [session.user.id, feedFilters ? JSON.stringify(feedFilters) : null, hiddenChannelIds ?? null]
  );

  return NextResponse.json({ ok: true });
}
