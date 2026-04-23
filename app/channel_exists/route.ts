import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';

// Every call goes to Postgres. No route caching — a caller's "does this
// channel exist" answer can flip in seconds as scrapers add rows.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /channel_exists
 *
 * Auth: admin token (Bearer hba_... / x-admin-token / admin cookie).
 *
 * Body: { "channelName": "Automation Mastery" }
 *
 * Looks up the channel across every table we track channel names in:
 *   - shorts_channels       (feed-spy / x-posts pipeline)
 *   - niche_spy_channels    (niche finder, enrichment-populated)
 *   - niche_spy_videos      (every scraped video — broadest coverage,
 *                            catches channels not yet enriched into
 *                            niche_spy_channels)
 *
 * Match is case-insensitive on trimmed whitespace: LOWER(TRIM(...)).
 * Functional indexes on each column are created lazily the first time
 * the route is hit so repeat lookups are O(log n) instead of seq scans.
 *
 * Response:
 *   200 { exists: true | false }
 *   400 { error: 'channelName is required', exists: false }
 *   403 { error: 'Unauthorized', exists: false }
 *   500 { error: '<message>', exists: false }
 */

// Module-level guard so we only attempt the CREATE INDEX statements once
// per process lifetime. CREATE INDEX IF NOT EXISTS is cheap but not free,
// and firing it on every request would waste a pool connection per call.
let indexesEnsured = false;

async function ensureIndexes(pool: Awaited<ReturnType<typeof getPool>>): Promise<void> {
  if (indexesEnsured) return;
  indexesEnsured = true;
  // Functional lowercase indexes. `.catch(() => {})` so a permission error
  // or a concurrent creation doesn't 500 the request — the query below still
  // works without the index, just slower, which is the "correct" fallback.
  await Promise.all([
    pool.query(`CREATE INDEX IF NOT EXISTS idx_shorts_channels_name_lower ON shorts_channels (LOWER(channel_name))`).catch(() => {}),
    pool.query(`CREATE INDEX IF NOT EXISTS idx_nsc_channel_name_lower ON niche_spy_channels (LOWER(channel_name))`).catch(() => {}),
    pool.query(`CREATE INDEX IF NOT EXISTS idx_nsv_channel_name_lower ON niche_spy_videos (LOWER(channel_name))`).catch(() => {}),
  ]);
}

export async function POST(req: NextRequest) {
  // Admin token auth — mirrors /api/admin/admin-tokens pattern.
  if (!(await isAdmin(req))) {
    return NextResponse.json({ error: 'Unauthorized', exists: false }, { status: 403 });
  }

  let body: { channelName?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body', exists: false }, { status: 400 });
  }

  const raw = body?.channelName;
  if (typeof raw !== 'string') {
    return NextResponse.json({ error: 'channelName is required', exists: false }, { status: 400 });
  }
  const name = raw.trim();
  if (name.length === 0) {
    return NextResponse.json({ error: 'channelName is required', exists: false }, { status: 400 });
  }

  try {
    const pool = await getPool();
    await ensureIndexes(pool);

    // Single EXISTS query over all three sources. Postgres short-circuits as
    // soon as any branch finds a match, so worst case we hit one index scan
    // per table; best case (common: channel already in shorts_channels) we
    // stop after one.
    //
    // We compare LOWER($1) to LOWER(channel_name). The $1 side is a literal
    // substituted by the driver, so the planner can use the functional
    // indexes idx_*_channel_name_lower created in ensureIndexes().
    const needle = name.toLowerCase();
    const result = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM shorts_channels
           WHERE channel_name IS NOT NULL AND LOWER(channel_name) = $1
         UNION ALL
         SELECT 1 FROM niche_spy_channels
           WHERE channel_name IS NOT NULL AND LOWER(channel_name) = $1
         UNION ALL
         SELECT 1 FROM niche_spy_videos
           WHERE channel_name IS NOT NULL AND LOWER(channel_name) = $1
         LIMIT 1
       ) AS exists`,
      [needle]
    );

    const exists = !!result.rows[0]?.exists;
    return NextResponse.json({ exists });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Internal error';
    return NextResponse.json({ error: message, exists: false }, { status: 500 });
  }
}
