import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { labelChannelNiche } from '@/lib/content-gen/niche-labeler';

/**
 * GET /api/admin/content-gen/niche-label-test?videoIds=1,2,3
 *      or                                     ?channelIds=UC..,UC..
 *
 * Test harness for catalog-based niche labeling. Resolves each video to
 * its channel, runs labelChannelNiche() over the channel's top videos'
 * titles + thumbnails, and returns the result. No persistence.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  let channelIds = (sp.get('channelIds') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const videoIds = (sp.get('videoIds') ?? '').split(',').map(s => parseInt(s.trim())).filter(n => Number.isFinite(n));

  const pool = await getPool();
  // Resolve videoIds → channelIds (+ keep a name for display).
  const nameByChannel = new Map<string, string>();
  if (videoIds.length > 0) {
    const r = await pool.query<{ channel_id: string; channel_name: string | null }>(
      `SELECT DISTINCT v.channel_id, c.channel_name
         FROM niche_spy_videos v
         LEFT JOIN niche_spy_channels c ON c.channel_id = v.channel_id
        WHERE v.id = ANY($1::int[]) AND v.channel_id IS NOT NULL`,
      [videoIds],
    );
    for (const row of r.rows) {
      channelIds.push(row.channel_id);
      if (row.channel_name) nameByChannel.set(row.channel_id, row.channel_name);
    }
    channelIds = Array.from(new Set(channelIds));
  }
  if (channelIds.length === 0) {
    return NextResponse.json({ error: 'videoIds or channelIds required' }, { status: 400 });
  }

  // Fill missing names.
  const missing = channelIds.filter(c => !nameByChannel.has(c));
  if (missing.length > 0) {
    const r = await pool.query<{ channel_id: string; channel_name: string | null }>(
      `SELECT channel_id, channel_name FROM niche_spy_channels WHERE channel_id = ANY($1::text[])`,
      [missing],
    );
    for (const row of r.rows) if (row.channel_name) nameByChannel.set(row.channel_id, row.channel_name);
  }

  const results = await Promise.all(channelIds.map(async (cid) => {
    const t0 = Date.now();
    try {
      const label = await labelChannelNiche(cid);
      return { channelId: cid, channelName: nameByChannel.get(cid) ?? null, ms: Date.now() - t0, label };
    } catch (e) {
      return { channelId: cid, channelName: nameByChannel.get(cid) ?? null, error: (e as Error).message };
    }
  }));

  return NextResponse.json({ ok: true, results });
}
