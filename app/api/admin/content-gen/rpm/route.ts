import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { getOrEstimateChannelRpm } from '@/lib/content-gen/rpm';

/**
 * Per-CHANNEL RPM cache (grounds on the actual channel via url_context).
 *
 * POST { videoIds?: number[], channelIds?: string[], force?: boolean }
 *   - Resolves videoIds → channels, estimates RPM per distinct channel
 *     (Gemini reads the channel URL + our niche/titles/subs context).
 *   - Returns {rpm_low, rpm_typical, rpm_high, geo_guess, url_fetched}
 *     per channel.
 *
 * GET ?channelIds=UC..,UC..  OR  (no params) → read the cache.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 180;

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as { videoIds?: number[]; channelIds?: string[]; force?: boolean };
  const force = body.force === true;

  const pool = await getPool();
  const channelIds = new Set<string>();
  if (Array.isArray(body.channelIds)) for (const c of body.channelIds) if (c) channelIds.add(c);
  if (Array.isArray(body.videoIds) && body.videoIds.length > 0) {
    const r = await pool.query<{ channel_id: string }>(
      `SELECT DISTINCT channel_id FROM niche_spy_videos
        WHERE id = ANY($1::int[]) AND channel_id IS NOT NULL`,
      [body.videoIds.filter(n => Number.isFinite(n))],
    );
    for (const row of r.rows) channelIds.add(row.channel_id);
  }
  if (channelIds.size === 0) {
    return NextResponse.json({ error: 'no channels resolved — pass channelIds[] or videoIds[]' }, { status: 400 });
  }

  const results = await Promise.all(Array.from(channelIds).map(async (cid) => {
    try {
      const rpm = await getOrEstimateChannelRpm(cid, force);
      return rpm;
    } catch (e) {
      return { channel_id: cid, error: (e as Error).message };
    }
  }));

  return NextResponse.json({
    ok: true,
    estimated: results.filter(r => !('error' in r) && !(r as { cached?: boolean }).cached).length,
    fromCache: results.filter(r => (r as { cached?: boolean }).cached).length,
    errored: results.filter(r => 'error' in r).length,
    results,
  });
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const pool = await getPool();
  const channelIds = (req.nextUrl.searchParams.get('channelIds') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  let rows;
  if (channelIds.length > 0) {
    rows = (await pool.query(`SELECT * FROM content_gen_channel_rpm WHERE channel_id = ANY($1::text[]) ORDER BY updated_at DESC`, [channelIds])).rows;
  } else {
    rows = (await pool.query(`SELECT * FROM content_gen_channel_rpm ORDER BY updated_at DESC LIMIT 200`)).rows;
  }
  return NextResponse.json({ ok: true, count: rows.length, cache: rows });
}
