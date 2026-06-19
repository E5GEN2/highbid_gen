import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';

/**
 * Video-seed error/success TIME SERIES + key-pool health.
 *
 * GET /api/admin/niche-spy/seed-error-curve?hours=6&bucketMin=15
 *
 * Powers the Video Seed tab's error curves so the operator can see whether
 * errors are stable or growing and which pool they come from (YT data keys vs
 * AI/embed keys vs thumbnail/data/db). Light + indexed (idx_nse_detected) — safe
 * to poll. Categories match lib/video-seed.ts emit strings + the existing
 * client classifier in VideoSeedTab.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const sp = req.nextUrl.searchParams;
  const hours = Math.min(Math.max(parseInt(sp.get('hours') || '6') || 6, 1), 72);
  const bucketMin = Math.min(Math.max(parseInt(sp.get('bucketMin') || '15') || 15, 5), 60);
  const bucketSec = bucketMin * 60;

  const pool = await getPool();

  // ── Time-bucketed success/error counts by category ──────────────────────
  const seriesRes = await pool.query<{
    bucket: string; total: string; success: string;
    yt_key: string; ai_key: string; thumb: string; data_err: string; db_err: string; other_err: string;
  }>(
    `SELECT
       to_timestamp(floor(extract(epoch from detected_at) / $2) * $2) AS bucket,
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE error_message IS NULL) AS success,
       COUNT(*) FILTER (WHERE error_message LIKE 'metadata fetch failed%') AS yt_key,
       COUNT(*) FILTER (WHERE error_message LIKE 'embed_api_failed%')      AS ai_key,
       COUNT(*) FILTER (WHERE error_message LIKE 'thumb_fetch_failed%')    AS thumb,
       COUNT(*) FILTER (WHERE error_message LIKE 'missing_title_or_thumb%') AS data_err,
       COUNT(*) FILTER (WHERE error_message LIKE 'persist_failed%')        AS db_err,
       COUNT(*) FILTER (WHERE error_message IS NOT NULL
                        AND error_message NOT LIKE 'metadata fetch failed%'
                        AND error_message NOT LIKE 'embed_api_failed%'
                        AND error_message NOT LIKE 'thumb_fetch_failed%'
                        AND error_message NOT LIKE 'missing_title_or_thumb%'
                        AND error_message NOT LIKE 'persist_failed%')      AS other_err
     FROM niche_seed_expansions
     WHERE detected_at > NOW() - ($1 || ' hours')::interval
     GROUP BY bucket
     ORDER BY bucket ASC`,
    [String(hours), bucketSec],
  );

  const buckets = seriesRes.rows.map(r => ({
    t: r.bucket,
    total: parseInt(r.total) || 0,
    success: parseInt(r.success) || 0,
    yt_key: parseInt(r.yt_key) || 0,
    ai_key: parseInt(r.ai_key) || 0,
    thumb: parseInt(r.thumb) || 0,
    data: parseInt(r.data_err) || 0,
    db: parseInt(r.db_err) || 0,
    other: parseInt(r.other_err) || 0,
  }));

  // ── Key-pool health (AI/embed vs YT data) ───────────────────────────────
  const keyRes = await pool.query<{ service: string; status: string; n: string }>(
    `SELECT COALESCE(service,'unknown') AS service, COALESCE(status,'unknown') AS status, COUNT(*) AS n
       FROM xgodo_api_keys GROUP BY service, status`,
  );
  const keyPools: Record<string, Record<string, number>> = { ai: {}, yt: {}, other: {} };
  for (const r of keyRes.rows) {
    const bucket = r.service === 'google_ai_studio' ? 'ai' : r.service === 'youtube_data' ? 'yt' : 'other';
    keyPools[bucket][r.status] = parseInt(r.n) || 0;
  }
  const poolSummary = (p: Record<string, number>) => {
    const active = p.active || 0, banned = p.banned || 0, invalid = p.invalid || 0;
    const total = active + banned + invalid + (p.unknown || 0);
    return { active, banned, invalid, total, pct_active: total ? Math.round((100 * active) / total) : 0 };
  };

  // ── Summary: error rate 1h vs 6h (trend) ────────────────────────────────
  const rateRes = await pool.query<{ total_1h: string; err_1h: string; total_6h: string; err_6h: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE detected_at > NOW()-INTERVAL '1 hour') AS total_1h,
       COUNT(*) FILTER (WHERE detected_at > NOW()-INTERVAL '1 hour' AND error_message IS NOT NULL) AS err_1h,
       COUNT(*) FILTER (WHERE detected_at > NOW()-INTERVAL '6 hours') AS total_6h,
       COUNT(*) FILTER (WHERE detected_at > NOW()-INTERVAL '6 hours' AND error_message IS NOT NULL) AS err_6h
     FROM niche_seed_expansions WHERE detected_at > NOW()-INTERVAL '6 hours'`,
  );
  const rr = rateRes.rows[0];
  const t1 = parseInt(rr?.total_1h) || 0, e1 = parseInt(rr?.err_1h) || 0;
  const t6 = parseInt(rr?.total_6h) || 0, e6 = parseInt(rr?.err_6h) || 0;
  const rate1h = t1 ? e1 / t1 : 0;
  const rate6h = t6 ? e6 / t6 : 0;
  const trend = rate6h === 0 ? 'stable' : rate1h > rate6h * 1.5 ? 'growing' : rate1h < rate6h * 0.66 ? 'improving' : 'stable';

  return NextResponse.json({
    ok: true,
    params: { hours, bucketMin },
    buckets,
    keyPools: { ai: poolSummary(keyPools.ai), yt: poolSummary(keyPools.yt), other: poolSummary(keyPools.other) },
    summary: {
      errorRate1h: rate1h,
      errorRate6h: rate6h,
      errors1h: e1, total1h: t1, errors6h: e6, total6h: t6,
      trend,
    },
  });
}
