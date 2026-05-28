import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';

/**
 * Admin: full detail of one embedding request, including the actual
 * video_ids array (kept off the list endpoint to keep that fast).
 *
 * GET /api/admin/embedding-requests/[id]
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const { id } = await ctx.params;
  const requestId = parseInt(id);
  if (Number.isNaN(requestId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

  const pool = await getPool();
  const r = await pool.query(
    `SELECT er.*, n.name AS niche_name, n.description AS niche_description
       FROM embedding_requests er
       LEFT JOIN custom_niches n ON n.id = er.custom_niche_id
      WHERE er.id = $1
      LIMIT 1`,
    [requestId],
  );
  if (r.rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const row = r.rows[0];

  // Pull the videos themselves so admin can eyeball what they'd be
  // embedding before pulling the trigger.
  const vidsRes = await pool.query(
    `SELECT id, url, title, thumbnail, channel_name, view_count
       FROM niche_spy_videos
      WHERE id = ANY($1::int[])
      LIMIT 200`,
    [row.video_ids],
  );

  return NextResponse.json({
    ok: true,
    request: {
      id: row.id,
      customNicheId: row.custom_niche_id,
      nicheName: row.niche_name,
      nicheDescription: row.niche_description,
      source: row.source,
      videoIds: row.video_ids,
      videoCount: row.video_count,
      requestedBy: row.requested_by,
      requesterLabel: row.requester_label,
      status: row.status,
      note: row.note,
      createdAt: row.created_at,
      processedAt: row.processed_at,
    },
    videos: vidsRes.rows.map(v => ({
      id: v.id, url: v.url, title: v.title,
      thumbnail: v.thumbnail, channelName: v.channel_name,
      viewCount: v.view_count,
    })),
  });
}
