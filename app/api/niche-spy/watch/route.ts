import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { auth } from '@/lib/auth';

/**
 * Niche Watch slots — per-user. A user spends one of MAX_WATCH_SLOTS to force
 * extra pulse + notifications on a niche they favourited.
 *   GET    → this user's watches + slots used/total
 *   POST   {clusterId, watchType?} → watch (enforces the slot cap)
 *   DELETE {clusterId} → unwatch
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_WATCH_SLOTS = 3;

export async function GET() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ watches: [], slotsUsed: 0, slotsTotal: MAX_WATCH_SLOTS });
  const pool = await getPool();
  const r = await pool.query<{ cluster_id: number; watch_type: string; created_at: string; label: string | null }>(
    `SELECT w.cluster_id, w.watch_type, w.created_at,
            COALESCE(c.label, c.ai_label, c.auto_label) AS label
       FROM user_niche_watches w
       LEFT JOIN niche_tree_clusters c ON c.id = w.cluster_id
      WHERE w.user_id = $1
      ORDER BY w.created_at DESC`,
    [userId],
  );
  return NextResponse.json({
    watches: r.rows.map(row => ({ clusterId: row.cluster_id, watchType: row.watch_type, label: row.label, createdAt: row.created_at })),
    slotsUsed: r.rows.length,
    slotsTotal: MAX_WATCH_SLOTS,
  });
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const userId = session.user.id;
  const { clusterId, watchType } = await req.json().catch(() => ({}));
  if (!clusterId || typeof clusterId !== 'number') {
    return NextResponse.json({ error: 'clusterId (number) required' }, { status: 400 });
  }
  const type = watchType === 'discover' ? 'discover' : 'cheap';
  const pool = await getPool();

  const chk = await pool.query('SELECT 1 FROM niche_tree_clusters WHERE id = $1', [clusterId]);
  if (chk.rows.length === 0) return NextResponse.json({ error: 'Cluster not found' }, { status: 404 });

  // Slot cap — only enforced for a NEW watch (re-watching an existing one just
  // updates its type, doesn't consume a slot).
  const already = await pool.query('SELECT 1 FROM user_niche_watches WHERE user_id = $1 AND cluster_id = $2', [userId, clusterId]);
  if (already.rows.length === 0) {
    const cnt = await pool.query<{ n: string }>('SELECT COUNT(*) AS n FROM user_niche_watches WHERE user_id = $1', [userId]);
    if ((parseInt(cnt.rows[0].n) || 0) >= MAX_WATCH_SLOTS) {
      return NextResponse.json(
        { error: `Watch limit reached (${MAX_WATCH_SLOTS}). Unwatch a niche to free a slot.`, slotsTotal: MAX_WATCH_SLOTS },
        { status: 409 },
      );
    }
  }

  await pool.query(
    `INSERT INTO user_niche_watches (user_id, cluster_id, watch_type) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, cluster_id) DO UPDATE SET watch_type = EXCLUDED.watch_type`,
    [userId, clusterId, type],
  );
  // Seed the per-niche cadence row so the watcher picks it up on the next tick.
  await pool.query(`INSERT INTO niche_watch_state (cluster_id) VALUES ($1) ON CONFLICT (cluster_id) DO NOTHING`, [clusterId]);
  // Baseline the user's seen-watermark at watch time — anything the watcher
  // discovers AFTER now is flagged NEW; pre-existing fresh videos aren't.
  await pool.query(
    `INSERT INTO user_niche_seen (user_id, cluster_id, last_viewed_at) VALUES ($1, $2, NOW())
       ON CONFLICT (user_id, cluster_id) DO NOTHING`,
    [userId, clusterId],
  ).catch(() => {});
  return NextResponse.json({ ok: true, watching: true });
}

export async function DELETE(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  const { clusterId } = await req.json().catch(() => ({}));
  if (!clusterId || typeof clusterId !== 'number') {
    return NextResponse.json({ error: 'clusterId (number) required' }, { status: 400 });
  }
  const pool = await getPool();
  await pool.query(`DELETE FROM user_niche_watches WHERE user_id = $1 AND cluster_id = $2`, [session.user.id, clusterId]);
  return NextResponse.json({ ok: true, watching: false });
}
