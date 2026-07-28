import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * EVENT TIMELINE for one tracked channel — the journey as a merged event stream
 * (docs/growth-watcher/spec.md). Answers, on one clock:
 *   • when a video was POSTED (and when we first saw it)
 *   • how many views each video had at each daily tick (+ per-tick delta)
 *   • how subs/video-count moved at each tick (+ per-tick delta)
 * so a subs jump can be attributed to the specific upload that drove it.
 *
 * GET ?channelId=UC...  →  { channel, days:[...], videos:[...], events:[...] }
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

interface DayRow { day: string; subscriber_count: string | null; video_count: number | null; source: string }
interface VidRow { video_id: number; title: string | null; url: string | null; is_short: boolean | null; posted_at: string | null; first_seen: string | null }
interface VsRow { video_id: number; day: string; view_count: string | null; like_count: string | null; comment_count: string | null }

export async function GET(req: NextRequest) {
  const channelId = req.nextUrl.searchParams.get('channelId');
  if (!channelId) return NextResponse.json({ error: 'channelId required' }, { status: 400 });
  const pool = await getPool();

  const [ch, days, vids, vsnaps] = await Promise.all([
    pool.query<{ channel_name: string; channel_avatar: string; channel_created_at: string | null; stage: string | null; first_caught_subs: string | null }>(
      `SELECT sc.channel_name, sc.channel_avatar, sc.channel_created_at::text,
              g.stage, g.first_caught_subs::text
         FROM niche_spy_channels sc
         LEFT JOIN growth_tracked_channels g ON g.channel_id = sc.channel_id
        WHERE sc.channel_id = $1`, [channelId]),
    pool.query<DayRow>(
      `SELECT day::text, subscriber_count::text, video_count, source
         FROM channel_growth_snapshots WHERE channel_id = $1 ORDER BY day ASC`, [channelId]),
    pool.query<VidRow>(
      `SELECT id AS video_id, title, url, is_short,
              posted_at::text, COALESCE(synced_at, fetched_at, enriched_at)::text AS first_seen
         FROM niche_spy_videos WHERE channel_id = $1
        ORDER BY posted_at DESC NULLS LAST`, [channelId]),
    pool.query<VsRow>(
      `SELECT vs.video_id, vs.day::text, vs.view_count::text, vs.like_count::text, vs.comment_count::text
         FROM video_growth_snapshots vs
         JOIN niche_spy_videos v ON v.id = vs.video_id
        WHERE v.channel_id = $1
        ORDER BY vs.video_id, vs.day ASC`, [channelId]),
  ]);

  if (ch.rows.length === 0) return NextResponse.json({ error: 'channel not found' }, { status: 404 });
  const c = ch.rows[0];
  const n = (x: string | null | undefined) => (x != null ? parseInt(x) : null);

  // Per-video daily view series + per-tick deltas.
  const seriesByVid = new Map<number, Array<{ day: string; views: number | null; delta: number | null }>>();
  for (const r of vsnaps.rows) {
    const arr = seriesByVid.get(r.video_id) ?? [];
    const views = n(r.view_count);
    const prev = arr.length > 0 ? arr[arr.length - 1].views : null;
    arr.push({ day: r.day, views, delta: (views != null && prev != null) ? views - prev : null });
    seriesByVid.set(r.video_id, arr);
  }

  const videos = vids.rows.map(v => ({
    videoId: v.video_id, title: v.title, url: v.url, isShort: v.is_short,
    postedAt: v.posted_at, firstSeen: v.first_seen,
    series: seriesByVid.get(v.video_id) ?? [],
    peakViews: (seriesByVid.get(v.video_id) ?? []).reduce((m, p) => Math.max(m, p.views ?? 0), 0),
  }));

  // Channel-level daily series + deltas.
  const dayRows = days.rows.map((d, i, all) => {
    const subs = n(d.subscriber_count);
    const prevSubs = i > 0 ? n(all[i - 1].subscriber_count) : null;
    const vc = d.video_count;
    const prevVc = i > 0 ? all[i - 1].video_count : null;
    return {
      day: d.day, subs, subsDelta: (subs != null && prevSubs != null) ? subs - prevSubs : null,
      videoCount: vc, videoCountDelta: (vc != null && prevVc != null) ? vc - prevVc : null,
      source: d.source,
    };
  });

  // ── Merged EVENT stream, chronological ────────────────────────────────
  type Event = { at: string; kind: 'upload' | 'discovered' | 'subs' | 'views'; videoId?: number;
                 title?: string | null; isShort?: boolean | null; value?: number | null; delta?: number | null; note?: string };
  const events: Event[] = [];

  for (const v of videos) {
    if (v.postedAt) events.push({ at: v.postedAt.slice(0, 10), kind: 'upload', videoId: v.videoId, title: v.title, isShort: v.isShort, note: 'video published' });
    else if (v.firstSeen) events.push({ at: v.firstSeen.slice(0, 10), kind: 'discovered', videoId: v.videoId, title: v.title, isShort: v.isShort, note: 'video first seen (no publish date)' });
    for (const p of v.series) {
      if (p.delta != null && p.delta !== 0) {
        events.push({ at: p.day, kind: 'views', videoId: v.videoId, title: v.title, isShort: v.isShort, value: p.views, delta: p.delta });
      }
    }
  }
  for (const d of dayRows) {
    if (d.subsDelta != null && d.subsDelta !== 0) events.push({ at: d.day, kind: 'subs', value: d.subs, delta: d.subsDelta });
    if (d.videoCountDelta != null && d.videoCountDelta > 0) {
      events.push({ at: d.day, kind: 'upload', value: d.videoCount, delta: d.videoCountDelta, note: `video_count +${d.videoCountDelta} (count-only; individual video unknown unless deep-tracked)` });
    }
  }
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

  return NextResponse.json({
    channelId,
    channel: {
      name: c.channel_name, avatar: c.channel_avatar, createdAt: c.channel_created_at,
      stage: c.stage, caughtSubs: n(c.first_caught_subs),
    },
    days: dayRows,
    videos,
    events,
    coverage: {
      videosInCorpus: videos.length,
      videosWithViewPulse: videos.filter(v => v.series.length > 0).length,
      daysTracked: dayRows.length,
    },
  });
}
