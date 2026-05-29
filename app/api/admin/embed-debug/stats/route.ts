import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { getProxyStats } from '@/lib/xgodo-proxy';

/**
 * GET /api/admin/embed-debug/stats
 *
 * One-shot snapshot of everything load-bearing on the embedding flow.
 * Built for Claude to curl when something looks off — answers
 * "is the key pool healthy?", "are proxies up?", "where's our
 * embedding coverage?", and "what's in flight right now?" without
 * needing DB access.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const pool = await getPool();

  // Key pool — Google AI Studio specifically (the embedding caller).
  const keyRowsRes = await pool.query<{ status: string; n: number; cooling: number }>(
    `SELECT status,
            COUNT(*)::int AS n,
            COUNT(*) FILTER (WHERE banned_until > NOW())::int AS cooling
       FROM xgodo_api_keys
      WHERE service = 'google_ai_studio'
      GROUP BY status
      ORDER BY status`,
  );
  const keys = {
    byStatus: keyRowsRes.rows.reduce((acc, r) => {
      acc[r.status] = { count: r.n, cooling: r.cooling };
      return acc;
    }, {} as Record<string, { count: number; cooling: number }>),
  };

  // Most recent invalidations / cooloffs for quick "is the pool decaying?" read.
  const recentBansRes = await pool.query(
    `SELECT LEFT(key, 12) AS key_preview, status, banned_until, invalidated_at, last_used_at
       FROM xgodo_api_keys
      WHERE service = 'google_ai_studio'
        AND (invalidated_at > NOW() - INTERVAL '24 hours'
             OR banned_until > NOW() - INTERVAL '1 hour')
      ORDER BY GREATEST(COALESCE(invalidated_at, '1970-01-01'::timestamptz), COALESCE(banned_until, '1970-01-01'::timestamptz)) DESC
      LIMIT 20`,
  );

  // Proxy pool stats — same helper the rest of the app uses.
  const proxyStats = await getProxyStats().catch(() => null);

  // Embedding coverage in niche_spy_videos for each source.
  const covRes = await pool.query<{
    total: number; title_v1: number; title_v2: number; thumbnail_v2: number; combined_v2: number;
    thumb_dead: number;
  }>(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE title_embedding         IS NOT NULL)::int AS title_v1,
            COUNT(*) FILTER (WHERE title_embedding_v2      IS NOT NULL)::int AS title_v2,
            COUNT(*) FILTER (WHERE thumbnail_embedding_v2  IS NOT NULL)::int AS thumbnail_v2,
            COUNT(*) FILTER (WHERE combined_embedding_v2   IS NOT NULL)::int AS combined_v2,
            COUNT(*) FILTER (WHERE thumbnail_dead_at       IS NOT NULL)::int AS thumb_dead
       FROM niche_spy_videos`,
  );

  // Embedding requests in flight + recent.
  const reqCountsRes = await pool.query<{ status: string; n: number }>(
    `SELECT status, COUNT(*)::int AS n FROM embedding_requests GROUP BY status`,
  );
  const requestCounts = reqCountsRes.rows.reduce((acc, r) => { acc[r.status] = r.n; return acc; }, {} as Record<string, number>);

  const inFlightRes = await pool.query(
    `SELECT id, custom_niche_id, source, video_count, processed, errors, note,
            EXTRACT(EPOCH FROM (NOW() - created_at))::int AS age_seconds
       FROM embedding_requests
      WHERE status IN ('pending', 'processing')
      ORDER BY created_at ASC
      LIMIT 20`,
  );

  // Niche-explorer's embedding job table (the OTHER embed driver) so
  // we can spot a competing run that might be hammering the key pool.
  const explorerJobRes = await pool.query(
    `SELECT id, status, target, keyword, processed, errors, current_batch, total_batches, started_at, finished_at, error_message
       FROM niche_spy_embedding_jobs
      ORDER BY started_at DESC
      LIMIT 3`,
  ).catch(() => ({ rows: [] }));

  return NextResponse.json({
    ok: true,
    at: new Date().toISOString(),
    keys,
    recentBans: recentBansRes.rows.map(r => ({
      keyPreview: r.key_preview,
      status: r.status,
      bannedUntil: r.banned_until,
      invalidatedAt: r.invalidated_at,
      lastUsedAt: r.last_used_at,
    })),
    proxies: proxyStats,
    coverage: covRes.rows[0] || null,
    requests: {
      counts: requestCounts,
      inFlight: inFlightRes.rows.map(r => ({
        id: r.id,
        customNicheId: r.custom_niche_id,
        source: r.source,
        videoCount: r.video_count,
        processed: r.processed,
        errors: r.errors,
        ageSeconds: r.age_seconds,
        note: r.note,
      })),
    },
    explorerJobs: explorerJobRes.rows,
  });
}
