import { NextRequest } from 'next/server';
import { getPool } from '@/lib/db';
import { auth } from '@/lib/auth';
import { extractYtVideoId } from '@/lib/video-seed';
import { pickRandomActiveYtPair } from '@/lib/yt-keys';
import { ytFetchViaProxy } from '@/lib/yt-proxy-fetch';
import { batchEmbedGrouped, type EmbedInput } from '@/lib/embeddings';

/**
 * POST /api/niche-spy/favourites/import
 *
 * Manual single-video import for the Favourites Videos tab. Takes
 * a YouTube URL, ensures we have a row in niche_spy_videos (insert
 * or fetch existing), generates the combined_v2 embedding if one
 * doesn't exist yet, and stars the video.
 *
 * Response is text/event-stream (SSE) — the browser reads progress
 * events as the pipeline runs so the user sees stage transitions
 * in real time. Final event is { stage: 'done', videoId, ... } on
 * success or { stage: 'error', message } on failure.
 *
 * Idempotent on URL: if the video already exists in the DB we
 * reuse it (no duplicate row), and if it's already starred the
 * star step is a no-op.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
// Allow up to 60s — the embedding call can take a few seconds and
// we don't want Vercel/Railway to cut the SSE stream short.
export const maxDuration = 60;

type Stage = 'validating' | 'checking' | 'fetching' | 'inserting' | 'embedding' | 'starring' | 'done' | 'error';
interface ProgressEvent {
  stage: Stage;
  message: string;
  // Only on the terminal events
  videoId?: number;
  ytId?: string;
  title?: string;
  thumbnail?: string;
  alreadyExisted?: boolean;
  alreadyStarred?: boolean;
}

interface YtVideoSnippet {
  id: string;
  snippet?: {
    title?: string;
    channelId?: string;
    channelTitle?: string;
    publishedAt?: string;
    thumbnails?: Record<string, { url: string }>;
  };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
}
interface YtVideosListResponse { items?: YtVideoSnippet[] }

function bestThumbnail(snip: YtVideoSnippet['snippet']): string | null {
  return (
    snip?.thumbnails?.maxres?.url ??
    snip?.thumbnails?.high?.url ??
    snip?.thumbnails?.medium?.url ??
    snip?.thumbnails?.default?.url ??
    null
  );
}

async function fetchThumbBase64(url: string): Promise<{ mimeType: string; data: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!res.ok) return null;
    const mimeType = res.headers.get('content-type')?.split(';')[0].trim() || 'image/jpeg';
    const buf = Buffer.from(await res.arrayBuffer());
    return { mimeType, data: buf.toString('base64') };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) return new Response('Unauthorized', { status: 401 });
  const userId = session.user.id;
  const body = await req.json().catch(() => ({})) as { url?: string };
  const rawUrl = (body.url || '').trim();

  const encoder = new TextEncoder();
  const stream = new TransformStream<Uint8Array, Uint8Array>();
  const writer = stream.writable.getWriter();
  const send = async (evt: ProgressEvent) => {
    // Standard SSE framing: each message is `data: <json>\n\n`.
    // The trailing blank line is REQUIRED — without it browsers
    // buffer until the connection closes.
    await writer.write(encoder.encode(`data: ${JSON.stringify(evt)}\n\n`));
  };

  // Kick off the import work concurrently with returning the
  // stream. The async IIFE owns the writer and closes it at the
  // end so the response cleanly terminates.
  (async () => {
    try {
      // ── 1. Validate ──────────────────────────────────────
      await send({ stage: 'validating', message: 'Validating URL…' });
      if (!rawUrl) {
        await send({ stage: 'error', message: 'No URL provided' });
        return;
      }
      const ytId = extractYtVideoId(rawUrl);
      if (!ytId) {
        await send({ stage: 'error', message: 'Not a valid YouTube URL' });
        return;
      }

      // ── 2. Check existing ───────────────────────────────
      await send({ stage: 'checking', message: 'Checking if the video is already in our database…' });
      const pool = await getPool();
      const existRes = await pool.query<{
        id: number; title: string | null; thumbnail: string | null;
        combined_embedded_v2_at: string | null;
      }>(
        // Match either the canonical youtu.be/<id> form or any URL
        // mentioning the id in v=… or /<id>… so the user can paste
        // any flavor of YouTube link.
        `SELECT id, title, thumbnail, combined_embedded_v2_at
           FROM niche_spy_videos
          WHERE url = $1
             OR url ~ $2
          LIMIT 1`,
        [`https://youtu.be/${ytId}`, `[?&]v=${ytId}\\b|/${ytId}\\b`],
      );

      let videoId: number;
      let title: string | null = null;
      let thumbnail: string | null = null;
      let alreadyExisted = false;
      let needsEmbedding = true;

      if (existRes.rows.length > 0) {
        const r = existRes.rows[0];
        videoId = r.id;
        title = r.title;
        thumbnail = r.thumbnail;
        alreadyExisted = true;
        needsEmbedding = !r.combined_embedded_v2_at;
        await send({
          stage: 'checking',
          message: needsEmbedding
            ? 'Video already in the database — will fill in the missing embedding.'
            : 'Video already in the database — skipping fetch and embedding.',
        });
      } else {
        // ── 3. Fetch metadata from YT Data API ──────────
        await send({ stage: 'fetching', message: 'Fetching metadata from YouTube…' });
        const pair = await pickRandomActiveYtPair();
        if (!pair) {
          await send({ stage: 'error', message: 'No YouTube API keys available right now' });
          return;
        }
        const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,statistics&id=${ytId}&key=${pair.key}`;
        const res = await ytFetchViaProxy(url, pair);
        if (!res.ok) {
          await send({ stage: 'error', message: `YouTube API error: ${res.status}` });
          return;
        }
        const data = res.data as YtVideosListResponse;
        const snip = data.items?.[0];
        if (!snip) {
          await send({ stage: 'error', message: 'YouTube returned no metadata for this video (private / removed?)' });
          return;
        }
        title = snip.snippet?.title ?? null;
        thumbnail = bestThumbnail(snip.snippet);
        const channelId = snip.snippet?.channelId ?? null;
        const channelName = snip.snippet?.channelTitle ?? null;
        const viewCount = parseInt(snip.statistics?.viewCount || '0') || 0;
        const likeCount = parseInt(snip.statistics?.likeCount || '0') || 0;
        const commentCount = parseInt(snip.statistics?.commentCount || '0') || 0;
        const postedAt = snip.snippet?.publishedAt ?? null;

        // ── 4. Insert into niche_spy_videos ─────────────
        await send({ stage: 'inserting', message: 'Saving the video to our database…' });
        const ins = await pool.query<{ id: number }>(
          // ON CONFLICT on the unique URL — handles the race where
          // a parallel import for the same URL arrived first. We
          // still get the row id back from the unchanged row.
          `INSERT INTO niche_spy_videos
             (url, title, thumbnail, channel_id, channel_name,
              view_count, like_count, comment_count, posted_at,
              keyword, task_id, enriched_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'manual-import', NOW())
           ON CONFLICT (url) DO UPDATE SET
             title       = COALESCE(EXCLUDED.title,       niche_spy_videos.title),
             thumbnail   = COALESCE(EXCLUDED.thumbnail,   niche_spy_videos.thumbnail),
             channel_id  = COALESCE(EXCLUDED.channel_id,  niche_spy_videos.channel_id),
             channel_name= COALESCE(EXCLUDED.channel_name,niche_spy_videos.channel_name),
             view_count  = GREATEST(EXCLUDED.view_count,  COALESCE(niche_spy_videos.view_count, 0)),
             like_count  = GREATEST(EXCLUDED.like_count,  COALESCE(niche_spy_videos.like_count, 0)),
             comment_count= GREATEST(EXCLUDED.comment_count,COALESCE(niche_spy_videos.comment_count, 0)),
             posted_at   = COALESCE(EXCLUDED.posted_at,   niche_spy_videos.posted_at)
           RETURNING id`,
          [
            `https://youtu.be/${ytId}`, title, thumbnail, channelId, channelName,
            viewCount, likeCount, commentCount, postedAt,
            'manual-import',
          ],
        );
        videoId = ins.rows[0].id;
      }

      // ── 5. Embed (combined v2 — title + thumbnail) ────
      // Skip if the row already has a combined_v2 embedding (cached
      // from prior pipeline runs). Skip if title or thumbnail is
      // missing — the multimodal embedding needs both.
      if (needsEmbedding && title && thumbnail) {
        await send({ stage: 'embedding', message: 'Generating multimodal embedding (title + thumbnail)…' });
        const img = await fetchThumbBase64(thumbnail);
        if (img) {
          const group: EmbedInput[] = [
            { type: 'text',  text: (title || '').slice(0, 1000) },
            { type: 'image', mimeType: img.mimeType, data: img.data },
          ];
          try {
            const [vec] = await batchEmbedGrouped([group], 'gemini-embedding-2-preview');
            if (vec && vec.length > 0) {
              const embStr = '[' + vec.join(',') + ']';
              const { vectorPool } = await import('@/lib/vector-db');
              await vectorPool.query(
                `INSERT INTO niche_video_vectors_combined_v2 (video_id, keyword, embedding)
                 VALUES ($1, $2, $3::vector)
                 ON CONFLICT (video_id) DO UPDATE SET embedding = EXCLUDED.embedding`,
                [videoId, 'manual-import', embStr],
              );
              await pool.query(
                `UPDATE niche_spy_videos
                    SET combined_embedding_v2 = $1::vector,
                        combined_embedded_v2_at = NOW()
                  WHERE id = $2`,
                [embStr, videoId],
              );
            }
          } catch (err) {
            // Don't fail the whole import on embedding error — the
            // video is still useful in Favourites without a vector;
            // it just won't show up in Similar searches.
            await send({
              stage: 'embedding',
              message: `Embedding failed (${(err as Error).message}). Video saved but Similar search won't include it.`,
            });
          }
        } else {
          await send({
            stage: 'embedding',
            message: 'Could not fetch thumbnail bytes — embedding skipped.',
          });
        }
      }

      // ── 6. Star ────────────────────────────────────────
      await send({ stage: 'starring', message: 'Adding to Favourites…' });
      const starInsert = await pool.query<{ video_id: number }>(
        `INSERT INTO niche_spy_favourites (user_id, video_id) VALUES ($1, $2)
         ON CONFLICT (user_id, video_id) DO NOTHING
         RETURNING video_id`,
        [userId, videoId],
      );
      const alreadyStarred = (starInsert.rowCount ?? 0) === 0;

      // ── 7. Done ────────────────────────────────────────
      await send({
        stage: 'done',
        message: alreadyExisted
          ? (alreadyStarred ? 'Video was already in your Favourites.' : 'Video added to Favourites.')
          : 'Video imported and starred.',
        videoId,
        ytId,
        title: title ?? undefined,
        thumbnail: thumbnail ?? undefined,
        alreadyExisted,
        alreadyStarred,
      });
    } catch (err) {
      await send({ stage: 'error', message: (err as Error).message || 'unknown error' });
    } finally {
      try { await writer.close(); } catch { /* already closed */ }
    }
  })();

  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      // Required on Vercel / some proxies — disables intermediate
      // response buffering so the client sees events as they're
      // written rather than all at once on close.
      'X-Accel-Buffering': 'no',
    },
  });
}
