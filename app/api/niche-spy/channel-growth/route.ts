import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

// Growth history for ONE tracked channel — powers the per-channel Growth page
// (docs/growth-watcher/spec.md). Catch story + daily subs/view series + per-video
// view trajectories (from channel_growth_snapshots / video_growth_snapshots).
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  const channelId = req.nextUrl.searchParams.get('channelId');
  if (!channelId) return NextResponse.json({ error: 'channelId required' }, { status: 400 });
  const pool = await getPool();

  const [ch, tracked, snaps, vids] = await Promise.all([
    pool.query<{ channel_name: string; channel_handle: string; channel_avatar: string; subscriber_count: string; video_count: number; channel_created_at: string | null }>(
      `SELECT channel_name, channel_handle, channel_avatar, subscriber_count::text, video_count, channel_created_at::text
         FROM niche_spy_channels WHERE channel_id = $1`, [channelId]),
    pool.query<{ stage: string; first_caught_subs: string | null; first_caught_at: string | null; last_subs: string | null; growth_score: string | null; showed_life: boolean; up_days: number; last_scanned_at: string | null }>(
      `SELECT stage, first_caught_subs::text, first_caught_at::text, last_subs::text, growth_score::text, showed_life, up_days, last_scanned_at::text
         FROM growth_tracked_channels WHERE channel_id = $1`, [channelId]),
    pool.query<{ day: string; subscriber_count: string | null; total_views: string | null; video_count: number | null; source: string }>(
      `SELECT day::text, subscriber_count::text, total_views::text, video_count, source
         FROM channel_growth_snapshots WHERE channel_id = $1 ORDER BY day ASC`, [channelId]),
    pool.query<{ video_id: number; title: string | null; url: string | null; max_views: string; series: unknown }>(
      `SELECT vs.video_id, v.title, v.url, MAX(vs.view_count)::text AS max_views,
              jsonb_agg(jsonb_build_object('day', vs.day, 'views', vs.view_count) ORDER BY vs.day) AS series
         FROM video_growth_snapshots vs
         JOIN niche_spy_videos v ON v.id = vs.video_id
        WHERE v.channel_id = $1
        GROUP BY vs.video_id, v.title, v.url
        ORDER BY MAX(vs.view_count) DESC
        LIMIT 12`, [channelId]),
  ]);

  if (ch.rows.length === 0 && tracked.rows.length === 0) {
    return NextResponse.json({ error: 'channel not found' }, { status: 404 });
  }
  const c = ch.rows[0];
  const t = tracked.rows[0];
  const caught = t?.first_caught_subs != null ? parseInt(t.first_caught_subs) : null;
  const current = (t?.last_subs != null ? parseInt(t.last_subs) : null) ?? (c?.subscriber_count != null ? parseInt(c.subscriber_count) : null);

  return NextResponse.json({
    channelId,
    channel: c ? {
      name: c.channel_name, handle: c.channel_handle, avatar: c.channel_avatar,
      subscribers: c.subscriber_count != null ? parseInt(c.subscriber_count) : null,
      videoCount: c.video_count, createdAt: c.channel_created_at,
    } : null,
    tracked: t ? {
      stage: t.stage,
      caughtSubs: caught,
      caughtAt: t.first_caught_at,
      currentSubs: current,
      subsGained: (current != null && caught != null) ? current - caught : null,
      multiple: (current != null && caught != null && caught > 0) ? +(current / caught).toFixed(1) : null,
      growthScore: t.growth_score != null ? parseFloat(t.growth_score) : 0,
      showedLife: t.showed_life,
      upDays: t.up_days,
      lastScannedAt: t.last_scanned_at,
    } : null,
    snapshots: snaps.rows.map(s => ({
      day: s.day,
      subscribers: s.subscriber_count != null ? parseInt(s.subscriber_count) : null,
      totalViews: s.total_views != null ? parseInt(s.total_views) : null,
      videoCount: s.video_count,
      source: s.source,
    })),
    videos: vids.rows.map(v => ({
      videoId: v.video_id, title: v.title, url: v.url,
      maxViews: parseInt(v.max_views),
      series: (v.series as Array<{ day: string; views: number }>) || [],
    })),
  });
}
