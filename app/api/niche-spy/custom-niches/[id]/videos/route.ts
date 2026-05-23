import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * Videos inside a single custom niche.
 *
 * GET  /api/niche-spy/custom-niches/[id]/videos
 *      ?sort=recent|centre|views|likes|score|newest|oldest   (default: recent)
 *      ?minScore=0|50|70|80|90                               (default: 0)
 *
 *   Hydrated rows in the same shape /api/niche-spy/favourites
 *   returns so the favourites Videos grid renders without
 *   conversion. Each row gets an optional `centre_distance`
 *   (cosine distance to the niche's centre embedding) when
 *   sort=centre; null otherwise.
 *
 * POST /api/niche-spy/custom-niches/[id]/videos
 *   body: { videoIds: number[] }
 *   → bulk-add the supplied videos to this niche.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

type SortKey = 'recent' | 'centre' | 'views' | 'likes' | 'score' | 'newest' | 'oldest';

function parseSort(v: string | null): SortKey {
  switch (v) {
    case 'centre':
    case 'views':
    case 'likes':
    case 'score':
    case 'newest':
    case 'oldest':
      return v;
    default:
      return 'recent';
  }
}
function parseMinScore(v: string | null): number {
  const n = parseInt(v ?? '0');
  if (![0, 50, 70, 80, 90].includes(n)) return 0;
  return n;
}

// ORDER BY clause for the main-DB sorts. Centre sort is handled
// separately via the vector DB.
function orderByForSort(sort: SortKey): string {
  switch (sort) {
    case 'views':  return 'v.view_count DESC NULLS LAST, m.added_at DESC';
    case 'likes':  return 'v.like_count DESC NULLS LAST, m.added_at DESC';
    case 'score':  return 'v.score      DESC NULLS LAST, m.added_at DESC';
    case 'newest': return 'v.posted_at  DESC NULLS LAST, m.added_at DESC';
    case 'oldest': return 'v.posted_at  ASC  NULLS LAST, m.added_at DESC';
    case 'recent':
    default:       return 'm.added_at DESC';
  }
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const nicheId = parseInt(id);
  if (Number.isNaN(nicheId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

  const sort = parseSort(req.nextUrl.searchParams.get('sort'));
  const minScore = parseMinScore(req.nextUrl.searchParams.get('minScore'));

  const pool = await getPool();
  // Defence: refuse if the niche doesn't exist. Also pulls
  // center_video_id so we know whether the centre sort is even
  // available (and use it for the vector lookup).
  const exists = await pool.query<{ center_video_id: number | null }>(
    'SELECT center_video_id FROM custom_niches WHERE id = $1',
    [nicheId],
  );
  if (exists.rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const centreId = exists.rows[0].center_video_id;

  // Pull all niche videos with main-DB ordering + score filter. For
  // sort=centre we re-order in JS using the vector-DB distances
  // below, so the SQL ORDER BY here is effectively a stable
  // fallback (centre videos without embeddings retain a sensible
  // order).
  const scoreFilter = minScore > 0 ? `AND v.score >= ${minScore}` : '';
  const orderBy = orderByForSort(sort === 'centre' ? 'recent' : sort);
  const r = await pool.query(`
    SELECT v.id, v.keyword, v.url, v.title, v.view_count, v.channel_name,
           v.posted_date, v.posted_at, v.score, v.subscriber_count, v.like_count,
           v.comment_count, v.top_comment, v.thumbnail, v.fetched_at,
           v.channel_created_at,
           v.embedded_at, v.title_embedded_v2_at, v.thumbnail_embedded_v2_at,
           c.first_upload_at, c.dormancy_days,
           m.added_at
      FROM custom_niche_videos m
      JOIN niche_spy_videos v ON v.id = m.video_id
      LEFT JOIN niche_spy_channels c ON c.channel_id = v.channel_id
     WHERE m.custom_niche_id = $1
       ${scoreFilter}
     ORDER BY ${orderBy}
  `, [nicheId]);

  // ─── Centre sort (cosine distance to the centre's embedding) ──
  // Lives in the vector DB. Two queries: one to fetch the centre's
  // vector, one to compute distances for the niche's videos. Both
  // are scoped tight by id so they're cheap. If the centre has no
  // embedding (rare; e.g. manually-imported video that hasn't been
  // embedded yet) we silently fall back to the recent sort and
  // emit a `centreUnavailable: true` flag so the client can warn.
  let centreUnavailable = false;
  if (sort === 'centre') {
    if (centreId == null) {
      centreUnavailable = true;
    } else if (r.rows.length > 0) {
      try {
        const { vectorPool } = await import('@/lib/vector-db');
        const ids = r.rows.map((row: { id: number }) => row.id);
        const distRes = await vectorPool.query<{ video_id: number; dist: string | null }>(
          `WITH centre AS (
             SELECT embedding FROM niche_video_vectors_combined_v2 WHERE video_id = $1
           )
           SELECT video_id,
                  (embedding <=> (SELECT embedding FROM centre))::text AS dist
             FROM niche_video_vectors_combined_v2
            WHERE video_id = ANY($2::int[])`,
          [centreId, ids],
        );
        const distById = new Map<number, number>();
        for (const row of distRes.rows) {
          if (row.dist != null) distById.set(row.video_id, parseFloat(row.dist));
        }
        // Stitch the distance onto each row + stable-sort by it.
        // Videos with no embedding (or where the centre has none)
        // sink to the bottom.
        const sortable = r.rows.map(row => ({
          ...row,
          centre_distance: distById.get((row as { id: number }).id) ?? null,
        }));
        sortable.sort((a, b) => {
          const da = (a as { centre_distance: number | null }).centre_distance;
          const db = (b as { centre_distance: number | null }).centre_distance;
          if (da == null && db == null) return 0;
          if (da == null) return 1;
          if (db == null) return -1;
          return da - db;
        });
        return NextResponse.json({
          videos: sortable, total: sortable.length, sort, minScore, centreUnavailable: false,
        });
      } catch {
        // Vector DB unavailable — fall back to the recent order.
        centreUnavailable = true;
      }
    }
  }

  return NextResponse.json({
    videos: r.rows, total: r.rows.length, sort, minScore, centreUnavailable,
  });
}

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const nicheId = parseInt(id);
  if (Number.isNaN(nicheId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

  const body = await req.json().catch(() => ({})) as { videoIds?: unknown };
  const videoIds = Array.isArray(body.videoIds)
    ? body.videoIds.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    : [];
  if (videoIds.length === 0) {
    return NextResponse.json({ error: 'videoIds (number[]) required' }, { status: 400 });
  }
  if (videoIds.length > 500) {
    return NextResponse.json({ error: 'max 500 videos per request' }, { status: 400 });
  }

  const pool = await getPool();
  const exists = await pool.query('SELECT 1 FROM custom_niches WHERE id = $1', [nicheId]);
  if (exists.rows.length === 0) return NextResponse.json({ error: 'niche not found' }, { status: 404 });

  const placeholders = videoIds.map((_, i) => `($${videoIds.length + 1}, $${i + 1})`).join(',');
  const r = await pool.query(
    `INSERT INTO custom_niche_videos (custom_niche_id, video_id) VALUES ${placeholders}
     ON CONFLICT DO NOTHING
     RETURNING video_id`,
    [...videoIds, nicheId],
  );
  if (r.rowCount && r.rowCount > 0) {
    await pool.query('UPDATE custom_niches SET updated_at = NOW() WHERE id = $1', [nicheId]);
  }

  return NextResponse.json({
    ok: true,
    added: r.rowCount ?? 0,
    skipped: videoIds.length - (r.rowCount ?? 0),
  });
}
