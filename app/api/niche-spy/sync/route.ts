import { NextResponse } from 'next/server';
import { Pool } from 'pg';
import { getPool } from '@/lib/db';

const NICHE_SPY_DB_URL = process.env.NICHE_SPY_DB_URL ||
  'postgresql://postgres:iIMtJTRLPmszObZVHzzlssNngxgkaijC@gondola.proxy.rlwy.net:41791/railway';

/** Parse "1,374,202 views" or "141K subscribers" or "1.2K" → number */
function parseCount(s: string | null): number {
  if (!s) return 0;
  s = s.replace(/,/g, '').replace(/\s*(views|subscribers)\s*/gi, '').trim();
  if (!s) return 0;
  const upper = s.toUpperCase();
  if (upper.endsWith('K')) return Math.round(parseFloat(s) * 1000);
  if (upper.endsWith('M')) return Math.round(parseFloat(s) * 1_000_000);
  if (upper.endsWith('B')) return Math.round(parseFloat(s) * 1_000_000_000);
  return parseInt(s) || 0;
}

/** Parse "2 years ago" relative to anchor date → absolute Date */
function parseRelativeDate(text: string | null, anchor: Date): Date | null {
  if (!text) return null;
  const match = text.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
  if (!match) return null;
  const n = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const d = new Date(anchor);
  switch (unit) {
    case 'second': d.setSeconds(d.getSeconds() - n); break;
    case 'minute': d.setMinutes(d.getMinutes() - n); break;
    case 'hour': d.setHours(d.getHours() - n); break;
    case 'day': d.setDate(d.getDate() - n); break;
    case 'week': d.setDate(d.getDate() - n * 7); break;
    case 'month': d.setMonth(d.getMonth() - n); break;
    case 'year': d.setFullYear(d.getFullYear() - n); break;
  }
  return d;
}

/**
 * POST /api/niche-spy/sync
 * Pull unsynced videos from external niche spy DB, parse, store locally.
 */
export async function POST() {
  const localPool = await getPool();

  const extPool = new Pool({
    connectionString: NICHE_SPY_DB_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
    connectionTimeoutMillis: 10000,
  });

  try {
    // Pull unsynced videos (batch of 1000)
    const { rows: videos } = await extPool.query(
      `SELECT * FROM niche_spy_videos WHERE synced_at IS NULL ORDER BY id LIMIT 1000`
    );

    if (videos.length === 0) {
      // Also pull pipeline runs
      const { rows: runs } = await extPool.query(
        `SELECT * FROM pipeline_runs WHERE synced_at IS NULL ORDER BY id LIMIT 100`
      );
      if (runs.length > 0) {
        for (const r of runs) {
          await localPool.query(
            `INSERT INTO niche_spy_pipeline_runs (external_id, ran_at, fetched, quality, duplicates, confirmed, new_urls, scheduled, declined)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (external_id) DO NOTHING`,
            [r.id, r.ran_at, r.fetched, r.quality, r.duplicates, r.confirmed, r.new_urls, r.scheduled, r.declined]
          );
        }
        await extPool.query(
          `UPDATE pipeline_runs SET synced_at = NOW() WHERE id = ANY($1)`,
          [runs.map(r => r.id)]
        );
      }
      return NextResponse.json({ synced: 0, pipelineRuns: runs.length, message: 'All videos already synced' });
    }

    // Parse and insert
    let synced = 0;
    const syncedIds: number[] = [];

    for (const v of videos) {
      const anchor = v.fetched_at ? new Date(v.fetched_at) : new Date();
      const postedAt = parseRelativeDate(v.posted_date, anchor);

      await localPool.query(
        `INSERT INTO niche_spy_videos
         (external_id, task_id, keyword, url, title, view_count, channel_name, posted_date, posted_at, score, subscriber_count, like_count, comment_count, top_comment, thumbnail, fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (external_id) DO UPDATE SET
           view_count=EXCLUDED.view_count, score=EXCLUDED.score, subscriber_count=EXCLUDED.subscriber_count,
           like_count=EXCLUDED.like_count, comment_count=EXCLUDED.comment_count, top_comment=EXCLUDED.top_comment`,
        [
          v.id, v.task_id, v.keyword, v.url, v.title,
          parseCount(v.view_count), v.channel_name, v.posted_date, postedAt,
          parseInt(v.score) || 0,
          parseCount(v.subscriber_count), parseCount(v.like_count), parseCount(v.comment_count),
          v.top_comment, v.thumbnail, v.fetched_at,
        ]
      );
      syncedIds.push(v.id);
      synced++;
    }

    // Stamp as synced on external DB
    if (syncedIds.length > 0) {
      await extPool.query(
        `UPDATE niche_spy_videos SET synced_at = NOW() WHERE id = ANY($1)`,
        [syncedIds]
      );
    }

    // Get total counts
    const { rows: [{ cnt: totalLocal }] } = await localPool.query('SELECT COUNT(*) as cnt FROM niche_spy_videos');
    const { rows: [{ cnt: totalExt }] } = await extPool.query('SELECT COUNT(*) as cnt FROM niche_spy_videos');
    const { rows: [{ cnt: remaining }] } = await extPool.query('SELECT COUNT(*) as cnt FROM niche_spy_videos WHERE synced_at IS NULL');

    return NextResponse.json({
      synced,
      totalLocal: parseInt(totalLocal),
      totalExternal: parseInt(totalExt),
      remaining: parseInt(remaining),
    });
  } catch (err) {
    console.error('[niche-spy sync]', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Sync failed' }, { status: 500 });
  } finally {
    await extPool.end();
  }
}

export const maxDuration = 120;
