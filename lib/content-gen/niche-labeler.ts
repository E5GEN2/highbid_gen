/**
 * Catalog-based niche labeling.
 *
 * The niche a channel occupies is a CHANNEL-level property — best read
 * from the breadth of what it makes (the titles + thumbnails of its top
 * videos), NOT from a single deep-dived video. Deep single-video
 * transcription mislabels: it saw one "computer viruses" video from
 * @FinestExplainerr and called the whole channel a computer-virus
 * channel, when it's actually a "[X] Explained in 8 Minutes" dark-
 * curiosity explainer (conspiracies, cursed images, banned toys, tech
 * disasters, Gen-Z trauma…).
 *
 * This reads the channel's top 6-10 videos (titles from our DB +
 * thumbnail images, multimodal) and asks Gemini for the niche. No
 * transcription needed — it's cheap and uses data we already have.
 *
 * Reuses the google_ai_studio key pool + proxy egress (mirrors
 * lib/content-gen/channel-analysis.ts).
 */

import { getPool } from '../db';
import { getRandomHealthyProxy } from '../xgodo-proxy';
import { fetchViaProxy } from '../proxy-dispatcher';

const NICHE_MODEL = 'gemini-2.5-flash';

export interface NicheLabel {
  niche_label: string;
  niche_summary: string;
  /** Whether the channel is single-topic or a broad "X explained" format. */
  breadth: 'single-topic' | 'broad-format';
  confidence: number;
  /** How many videos + thumbnails actually fed the decision. */
  sampled_videos: number;
  sampled_thumbnails: number;
}

interface VideoRow {
  title: string | null;
  thumbnail: string | null;
  view_count: number;
}

async function pickAiStudioKey(): Promise<{ id: number; key: string } | null> {
  const pool = await getPool();
  const r = await pool.query<{ id: number; key: string }>(
    `SELECT id, key FROM xgodo_api_keys
      WHERE service = 'google_ai_studio' AND status = 'active'
        AND (banned_until IS NULL OR banned_until < NOW())
      ORDER BY RANDOM() LIMIT 1`,
  );
  return r.rows[0] ?? null;
}

function cooloffKey(keyId: number, seconds = 90): void {
  void (async () => {
    try {
      const pool = await getPool();
      await pool.query(
        `UPDATE xgodo_api_keys SET banned_until = NOW() + ($1 || ' seconds')::interval WHERE id = $2`,
        [String(seconds), keyId],
      );
    } catch { /* fire-and-forget */ }
  })();
}

/** Fetch a thumbnail and return base64 + mime, or null if dead/unfetchable. */
async function fetchThumb(url: string): Promise<{ data: string; mime: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const mime = res.headers.get('content-type') || 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) return null; // YouTube's 404 placeholder is tiny
    return { data: buf.toString('base64'), mime };
  } catch {
    return null;
  }
}

/**
 * Produce a clean niche label for a channel from its top videos' titles
 * + thumbnails.
 */
export async function labelChannelNiche(
  channelId: string,
  opts: { topN?: number; maxThumbs?: number; maxAttempts?: number } = {},
): Promise<NicheLabel> {
  const topN = Math.max(4, Math.min(15, opts.topN ?? 10));
  const maxThumbs = Math.max(0, Math.min(10, opts.maxThumbs ?? 8));
  const maxAttempts = opts.maxAttempts ?? 4;

  const pool = await getPool();
  const r = await pool.query<VideoRow>(
    `SELECT title, thumbnail, view_count
       FROM niche_spy_videos
      WHERE channel_id = $1
        AND title IS NOT NULL
        AND thumbnail_dead_at IS NULL
      ORDER BY view_count DESC NULLS LAST
      LIMIT $2`,
    [channelId, topN],
  );
  const videos = r.rows.filter(v => v.title);
  if (videos.length === 0) {
    throw new Error(`no live titled videos in DB for channel ${channelId}`);
  }

  // Fetch up to maxThumbs thumbnails (top videos first) in parallel.
  const thumbCandidates = videos.filter(v => v.thumbnail).slice(0, maxThumbs);
  const thumbs = (await Promise.all(
    thumbCandidates.map(async (v) => ({ title: v.title!, img: await fetchThumb(v.thumbnail!) })),
  )).filter(t => t.img);

  const titlesBlock = videos.map((v, i) =>
    `${i + 1}. "${v.title}" (${v.view_count?.toLocaleString() ?? '?'} views)`,
  ).join('\n');

  const promptText = `You are identifying the NICHE of a faceless YouTube channel from its catalog.

Below are the channel's top ${videos.length} videos by views (titles). ${thumbs.length} thumbnails are also attached as images, in title order.

TOP VIDEOS:
${titlesBlock}

Look at the BREADTH across all videos — not just one. Many faceless channels use a repeatable format (e.g. "[Topic] Explained in 8 Minutes") spanning many different subjects. Capture the channel's actual recurring niche/format, not just the subject of the single top video.

Produce ONLY this JSON (no prose, no fences):

{
  "niche_label": string,     // Clean, human-readable 2-6 word niche name a viewer would recognize and that fits as a "Top 10 niches" listicle item. Capture the FORMAT + theme. e.g. "Dark internet mysteries explained", "Faceless history documentaries", "Healing frequency music", "Extinct & cryptid animals". NOT keyword soup, NOT the single top video's subject.
  "niche_summary": string,   // 1 sentence describing what this channel consistently makes across its catalog.
  "breadth": string,         // "single-topic" if every video is the same subject, or "broad-format" if it's a repeatable format across many subjects.
  "confidence": number       // 0-1
}`;

  const parts: Array<Record<string, unknown>> = [{ text: promptText }];
  for (const t of thumbs) {
    parts.push({ inlineData: { mimeType: t.img!.mime, data: t.img!.data } });
  }

  let lastErr = 'unknown';
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Backoff between attempts to ride out transient 503 (model overload)
    // / proxy auth blips. 0s, 1.5s, 3s, 4.5s.
    if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 1500));
    const keyRow = await pickAiStudioKey();
    if (!keyRow) { lastErr = 'no active google_ai_studio key'; break; }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${NICHE_MODEL}:generateContent?key=${keyRow.key}`;
    const body = JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        temperature: 0.3, topP: 0.9, maxOutputTokens: 2048,
        responseMimeType: 'application/json',
        // gemini-2.5-flash enables "thinking" by default, which silently
        // consumes the output-token budget before the JSON closes →
        // unterminated-string parse errors. This is a simple labeling
        // task; disable thinking so the full budget goes to the answer.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const proxy = await getRandomHealthyProxy().catch(() => null);
    let res: { ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> };
    try {
      if (proxy?.url) {
        res = await fetchViaProxy(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          timeoutMs: 60_000,
        }, proxy.url);
      } else {
        const rr = await fetch(url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body, signal: AbortSignal.timeout(60_000),
        });
        res = { ok: rr.ok, status: rr.status, text: () => rr.text(), json: () => rr.json() };
      }
    } catch (e) {
      lastErr = `connection: ${(e as Error).message}`;
      continue;
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      if (res.status === 429) cooloffKey(keyRow.id, 90);
      lastErr = `HTTP ${res.status}: ${errBody.slice(0, 160)}`;
      continue;
    }

    const data = await res.json().catch(() => null) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      error?: { message?: string };
    } | null;
    if (!data || data.error) { lastErr = `gemini error: ${data?.error?.message ?? 'null'}`; continue; }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!text) { lastErr = 'empty response'; continue; }

    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

    // Tolerant parse. Responses occasionally truncate mid-niche_summary
    // (intermittent proxy body-read / long summary). niche_label is the
    // FIRST field and short, so it's complete even when the tail is cut.
    // Try strict JSON first; on failure, regex-salvage the fields we can.
    let niche_label: string | null = null;
    let niche_summary = '';
    let breadthRaw = '';
    let confidence = 0.5;
    try {
      const parsed = JSON.parse(cleaned) as Partial<NicheLabel>;
      niche_label = parsed.niche_label ? String(parsed.niche_label) : null;
      niche_summary = String(parsed.niche_summary ?? '');
      breadthRaw = String(parsed.breadth ?? '');
      if (typeof parsed.confidence === 'number') confidence = parsed.confidence;
    } catch {
      const mLabel = cleaned.match(/"niche_label"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (mLabel) niche_label = mLabel[1].replace(/\\"/g, '"');
      const mSum = cleaned.match(/"niche_summary"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      if (mSum) niche_summary = mSum[1].replace(/\\"/g, '"');
      const mBr = cleaned.match(/"breadth"\s*:\s*"(single-topic|broad-format)"/);
      if (mBr) breadthRaw = mBr[1];
      const mConf = cleaned.match(/"confidence"\s*:\s*([0-9.]+)/);
      if (mConf) confidence = parseFloat(mConf[1]);
    }

    if (!niche_label) { lastErr = `could not extract niche_label from: ${cleaned.slice(0, 120)}`; continue; }

    return {
      niche_label:        niche_label.trim(),
      niche_summary:      niche_summary.trim(),
      breadth:            breadthRaw === 'single-topic' ? 'single-topic' : 'broad-format',
      confidence,
      sampled_videos:     videos.length,
      sampled_thumbnails: thumbs.length,
    };
  }

  throw new Error(`niche labeling failed after ${maxAttempts} attempts: ${lastErr}`);
}
