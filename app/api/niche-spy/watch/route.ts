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

  // The count-then-insert slot cap must be atomic, else two concurrent POSTs
  // for different clusters both read count<3 and both insert (>3 watches). A
  // per-user advisory xact lock serializes this user's watch writes; it auto-
  // releases on COMMIT/ROLLBACK. Watch writes are rare (a click) so contention
  // is nil.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`niche-watch:${userId}`]);

    const chk = await client.query('SELECT 1 FROM niche_tree_clusters WHERE id = $1', [clusterId]);
    if (chk.rows.length === 0) {
      await client.query('ROLLBACK');
      return NextResponse.json({ error: 'Cluster not found' }, { status: 404 });
    }

    // Slot cap — only enforced for a NEW watch (re-watching an existing one
    // just updates its type, doesn't consume a slot).
    const already = await client.query('SELECT 1 FROM user_niche_watches WHERE user_id = $1 AND cluster_id = $2', [userId, clusterId]);
    const isNew = already.rows.length === 0;
    if (isNew) {
      const cnt = await client.query<{ n: string }>('SELECT COUNT(*) AS n FROM user_niche_watches WHERE user_id = $1', [userId]);
      if ((parseInt(cnt.rows[0].n) || 0) >= MAX_WATCH_SLOTS) {
        await client.query('ROLLBACK');
        return NextResponse.json(
          { error: `Watch limit reached (${MAX_WATCH_SLOTS}). Unwatch a niche to free a slot.`, slotsTotal: MAX_WATCH_SLOTS },
          { status: 409 },
        );
      }
    }

    await client.query(
      `INSERT INTO user_niche_watches (user_id, cluster_id, watch_type) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, cluster_id) DO UPDATE SET watch_type = EXCLUDED.watch_type`,
      [userId, clusterId, type],
    );
    // Seed the per-niche cadence row so the watcher picks it up on the next tick.
    await client.query(`INSERT INTO niche_watch_state (cluster_id) VALUES ($1) ON CONFLICT (cluster_id) DO NOTHING`, [clusterId]);
    // Baseline the seen-watermark to NOW() ONLY for a genuinely new watch — so
    // videos the watcher found while this user WASN'T watching aren't dumped on
    // them as NEW. DO UPDATE (not DO NOTHING) overwrites a stale watermark left
    // by a prior watch→unwatch cycle. An existing active watch keeps its
    // progress (no reset).
    if (isNew) {
      await client.query(
        `INSERT INTO user_niche_seen (user_id, cluster_id, last_viewed_at) VALUES ($1, $2, NOW())
           ON CONFLICT (user_id, cluster_id) DO UPDATE SET last_viewed_at = NOW()`,
        [userId, clusterId],
      );
    }
    await client.query('COMMIT');
    return NextResponse.json({ ok: true, watching: true });
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  } finally {
    client.release();
  }
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
  // Drop the seen-watermark too so a later re-watch baselines cleanly (no stale
  // last_viewed_at that would wall the user with NEW for the gap period).
  await pool.query(`DELETE FROM user_niche_seen WHERE user_id = $1 AND cluster_id = $2`, [session.user.id, clusterId]).catch(() => {});
  return NextResponse.json({ ok: true, watching: false });
}
