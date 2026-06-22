import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { findSeedCandidates } from '@/lib/content-gen/seed-candidates';
import { getPool } from '@/lib/db';

/**
 * GET /api/admin/content-gen/seed-candidates
 *
 * Returns videos to seed xgodo bots with for auto-niche discovery.
 * Combines novelty (isolation in embedding space) with content-gen
 * discovery rules (channel quality A1-D2).
 *
 * See docs/content-gen/novelty-audit.md for the full design.
 *
 * Query params:
 *   topK            default 30, max 200
 *   minNoveltyPct   default 80 (top 20% novelty), range 0-99.9
 *   minSubs         default 10_000
 *   maxSubs         default 5_000_000
 *   topVideoOnly    'true' to restrict seed = channel's #1 top-view video
 *   longFormOnly    'true' to skip /shorts/ URLs
 *
 * Response:
 *   {
 *     ok, elapsedMs,
 *     params,
 *     pool: { videos_with_novelty, novelty_cutoff_used, ... },
 *     seeds: SeedCandidate[]
 *   }
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) {
    return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  const topK          = Math.max(1, Math.min(200, parseInt(sp.get('topK') ?? '30') || 30));
  const minNoveltyPct = Math.max(0, Math.min(99.9, parseFloat(sp.get('minNoveltyPct') ?? '80')));
  const minSubs       = parseInt(sp.get('minSubs') ?? '10000')   || 10_000;
  const maxSubs       = parseInt(sp.get('maxSubs') ?? '5000000') || 5_000_000;
  const topVideoOnly  = sp.get('topVideoOnly') === 'true';
  const longFormOnly  = sp.get('longFormOnly') === 'true';
  // The panel shows what CAN still be seeded — exclude videos already in the
  // ledger by default (matches what the scheduler actually picks). Pass
  // ?includeSeeded=true to see the raw ranking including already-used ones.
  const includeSeeded = sp.get('includeSeeded') === 'true';

  const t0 = Date.now();

  // Pool-size diagnostic so we can see "how many videos in our DB have a
  // novelty score" and "what's the absolute cutoff that minNoveltyPct
  // converted into" without re-querying client-side.
  const pool = await getPool();
  const poolRes = await pool.query<{
    total_with_novelty: string;
    cutoff: number | null;
    above_cutoff: string;
  }>(
    `WITH all_scored AS (
       SELECT novelty_score FROM niche_spy_videos WHERE novelty_score IS NOT NULL
     ),
     cutoff_calc AS (
       SELECT PERCENTILE_CONT($1) WITHIN GROUP (ORDER BY novelty_score) AS cutoff FROM all_scored
     )
     SELECT
       (SELECT COUNT(*) FROM all_scored) AS total_with_novelty,
       (SELECT cutoff FROM cutoff_calc) AS cutoff,
       (SELECT COUNT(*) FROM all_scored, cutoff_calc WHERE novelty_score >= cutoff) AS above_cutoff`,
    [minNoveltyPct / 100],
  );

  // English-only: query param overrides; default = the persisted scheduler
  // setting (ON unless seed_english_only='false'), so the preview matches what
  // the scheduler will actually pick.
  const englishParam = sp.get('englishOnly');
  const englishOnly = englishParam === 'true' ? true
    : englishParam === 'false' ? false
    : (await pool.query<{ value: string }>(`SELECT value FROM admin_config WHERE key='seed_english_only'`)).rows[0]?.value !== 'false';

  const seeds = await findSeedCandidates({
    topK, minNoveltyPct, minSubs, maxSubs, topVideoOnly, longFormOnly,
    excludeSeeded: !includeSeeded, englishOnly,
  });

  return NextResponse.json({
    ok: true,
    elapsedMs: Date.now() - t0,
    params: { topK, minNoveltyPct, minSubs, maxSubs, topVideoOnly, longFormOnly, englishOnly },
    pool: {
      total_videos_with_novelty: parseInt(poolRes.rows[0]?.total_with_novelty ?? '0'),
      novelty_cutoff_used:       poolRes.rows[0]?.cutoff != null ? parseFloat(String(poolRes.rows[0].cutoff)) : null,
      videos_above_cutoff:       parseInt(poolRes.rows[0]?.above_cutoff ?? '0'),
      seeds_after_channel_rules: seeds.length,
    },
    seeds,
  });
}
