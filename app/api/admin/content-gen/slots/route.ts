import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { assembleChannelSlots } from '@/lib/content-gen/slot-fill';

/**
 * GET /api/admin/content-gen/slots?videoIds=1,2,3
 *      or                          ?channelIds=UC..,UC..
 *
 * Assembles the complete per-channel data inventory (DB stats + analysis
 * + RPM + money math) for a group — exactly what the script generator
 * will consume. Read-only; computes on the fly.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  let channelIds = (sp.get('channelIds') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const videoIds = (sp.get('videoIds') ?? '').split(',').map(s => parseInt(s.trim())).filter(n => Number.isFinite(n));

  const pool = await getPool();
  if (videoIds.length > 0) {
    const r = await pool.query<{ channel_id: string }>(
      `SELECT DISTINCT channel_id FROM niche_spy_videos WHERE id = ANY($1::int[]) AND channel_id IS NOT NULL`,
      [videoIds],
    );
    channelIds = Array.from(new Set([...channelIds, ...r.rows.map(x => x.channel_id)]));
  }
  if (channelIds.length === 0) {
    return NextResponse.json({ error: 'videoIds or channelIds required' }, { status: 400 });
  }

  const slots = await Promise.all(channelIds.map(async (cid) => {
    try { return await assembleChannelSlots(cid); }
    catch (e) { return { channel_id: cid, error: (e as Error).message }; }
  }));

  const ready = slots.filter(s => !('error' in s) && (s as { has_analysis?: boolean }).has_analysis && (s as { has_rpm?: boolean }).has_rpm).length;

  return NextResponse.json({
    ok: true,
    channels: channelIds.length,
    fully_ready: ready,
    slots,
  });
}
