import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * PUBLIC feed of the broadcast posts we push to Telegram — powers the rofe.ai
 * landing grid. Returns the rendered post text plus the imagery the Telegram
 * cards were built from (channel avatar + top-video thumbnails), since the
 * outbound photos themselves are uploaded to Telegram and not stored as URLs.
 *
 * GET ?before=<id>&limit=24   → older posts (keyset pagination, infinite scroll)
 * GET ?after=<id>             → newer posts only (live polling for new arrivals)
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

const MAX_LIMIT = 40;

/** Telegram payloads are HTML we generate ourselves (b/i/a/code/br). Whitelist
 *  those, drop every other tag, and neutralise href schemes — the grid renders
 *  this into the DOM, so nothing unexpected should survive. */
function sanitize(html: string): string {
  let s = html.replace(/<(?!\/?(?:b|strong|i|em|u|s|code|br|a)\b)[^>]*>/gi, '');
  s = s.replace(/<a\b([^>]*)>/gi, (_m, attrs: string) => {
    const m = /href\s*=\s*["']([^"']+)["']/i.exec(attrs);
    const href = m?.[1] ?? '';
    if (!/^https?:\/\//i.test(href)) return '<a>';
    const safe = href.replace(/"/g, '&quot;');
    return `<a href="${safe}" target="_blank" rel="noopener noreferrer nofollow">`;
  });
  return s;
}

interface Row {
  id: number; kind: string; posted_at: string; channel_id: string | null; payload: string | null;
  channel_name: string | null; channel_avatar: string | null; subscriber_count: string | null;
  thumbs: string[] | null;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const before = parseInt(sp.get('before') || '') || null;
  const after = parseInt(sp.get('after') || '') || null;
  const limit = Math.min(MAX_LIMIT, Math.max(1, parseInt(sp.get('limit') || '24') || 24));
  const pool = await getPool();

  const where = before ? 'AND bp.id < $2' : after ? 'AND bp.id > $2' : '';
  const params: unknown[] = [limit];
  if (before || after) params.push(before ?? after);

  // 1) Posts + channel meta — PK joins only, always fast.
  const r = await pool.query<Row>(
    `SELECT bp.id, bp.kind, bp.posted_at::text, bp.channel_id, bp.payload,
            sc.channel_name, sc.channel_avatar, sc.subscriber_count::text,
            NULL::text[] AS thumbs
       FROM broadcast_posts bp
       LEFT JOIN niche_spy_channels sc ON sc.channel_id = bp.channel_id
      WHERE bp.ok AND bp.payload IS NOT NULL ${where}
      ORDER BY bp.id DESC
      LIMIT $1`,
    params,
  );

  // 2) Thumbnails — BEST EFFORT, on its own short-timeout connection. Ranking a
  //    channel's videos by views needs an index on niche_spy_videos(channel_id,
  //    view_count) — without it this seq-scans 3.7M rows (68s, measured). Rather
  //    than let the public landing page hang on that, we cap it and degrade to
  //    avatar-only cards; thumbnails light up by themselves once the index
  //    exists. Never let this leg fail the request.
  const thumbsByChannel = new Map<string, string[]>();
  const channelIds = [...new Set(r.rows.map(x => x.channel_id).filter((x): x is string => !!x))];
  if (channelIds.length > 0) {
    const client = await pool.connect().catch(() => null);
    if (client) {
      try {
        await client.query(`SET LOCAL statement_timeout = '2500ms'`).catch(() => {});
        // NB: no generic on client.query — the `.catch(() => null)` on connect()
        // widens PoolClient so its query() reads as untyped ("Untyped function
        // calls may not accept type arguments"); cast the result instead.
        const t = await client.query(
          `SELECT channel_id, ARRAY_AGG(thumbnail ORDER BY view_count DESC NULLS LAST) AS thumbs
             FROM (
               SELECT v.channel_id, v.thumbnail, v.view_count,
                      ROW_NUMBER() OVER (PARTITION BY v.channel_id ORDER BY v.view_count DESC NULLS LAST) rn
                 FROM niche_spy_videos v
                WHERE v.channel_id = ANY($1) AND v.thumbnail IS NOT NULL
             ) s WHERE rn <= 4
            GROUP BY channel_id`,
          [channelIds],
        ) as { rows: Array<{ channel_id: string; thumbs: string[] }> };
        for (const row of t.rows) thumbsByChannel.set(row.channel_id, row.thumbs || []);
      } catch { /* timeout / error → avatar-only cards this request */ }
      finally { client.release(); }
    }
  }

  const posts = r.rows.map(p => ({
    id: p.id,
    kind: p.kind,
    postedAt: p.posted_at,
    channelId: p.channel_id,
    channelName: p.channel_name,
    channelAvatar: p.channel_avatar,
    subscribers: p.subscriber_count != null ? parseInt(p.subscriber_count) : null,
    channelUrl: p.channel_id ? `https://www.youtube.com/channel/${p.channel_id}` : null,
    html: sanitize(p.payload || ''),
    thumbs: (p.channel_id ? (thumbsByChannel.get(p.channel_id) || []) : []).filter(Boolean).slice(0, 4),
  }));

  return NextResponse.json({
    posts,
    nextCursor: posts.length === limit ? posts[posts.length - 1].id : null,
    newestId: posts.length > 0 ? posts[0].id : null,
  });
}
