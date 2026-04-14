import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';

/**
 * POST /api/admin/dedup
 * Deduplicate niche_spy_videos by YouTube video ID.
 * Keeps the row with the highest score (or most recent if tied).
 * Also normalizes URLs to strip query params.
 */
export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const pool = await getPool();

  // Step 1: Find duplicates by extracting video ID from URL
  const dupsRes = await pool.query(`
    WITH video_ids AS (
      SELECT id, url, score,
             SUBSTRING(url FROM '(?:youtu\\.be/|[?&]v=|/shorts/)([a-zA-Z0-9_-]{11})') as vid
      FROM niche_spy_videos
      WHERE url IS NOT NULL
    ),
    ranked AS (
      SELECT id, vid, url,
             ROW_NUMBER() OVER (PARTITION BY vid ORDER BY score DESC NULLS LAST, id DESC) as rn
      FROM video_ids
      WHERE vid IS NOT NULL
    )
    SELECT id, vid, url FROM ranked WHERE rn > 1
  `);

  const toDelete = dupsRes.rows.map(r => r.id);

  if (toDelete.length === 0) {
    return NextResponse.json({ deleted: 0, message: 'No duplicates found' });
  }

  // Step 2: Delete duplicates
  if (toDelete.length > 0) {
    await pool.query('DELETE FROM niche_spy_videos WHERE id = ANY($1)', [toDelete]);
  }

  // Step 3: Remove invalid URLs (search pages, non-video links)
  const invalidRes = await pool.query(`
    DELETE FROM niche_spy_videos
    WHERE url IS NOT NULL
      AND url !~ '(?:youtu\\.be/|[?&]v=|/shorts/|/embed/)[a-zA-Z0-9_-]{11}'
    RETURNING id
  `);
  const invalidDeleted = invalidRes.rowCount || 0;

  // Step 4: Normalize remaining URLs (strip query params)
  const normalizedRes = await pool.query(`
    UPDATE niche_spy_videos
    SET url = 'https://youtu.be/' || SUBSTRING(url FROM '(?:youtu\\.be/|[?&]v=|/shorts/)([a-zA-Z0-9_-]{11})')
    WHERE url LIKE '%?%' AND url ~ '(?:youtu\\.be/|[?&]v=|/shorts/)[a-zA-Z0-9_-]{11}'
  `);
  const normalized = normalizedRes.rowCount || 0;

  return NextResponse.json({
    duplicatesDeleted: toDelete.length,
    invalidUrlsDeleted: invalidDeleted,
    urlsNormalized: normalized,
    message: `Removed ${toDelete.length} duplicates + ${invalidDeleted} invalid URLs. Normalized ${normalized} URLs.`,
  });
}
