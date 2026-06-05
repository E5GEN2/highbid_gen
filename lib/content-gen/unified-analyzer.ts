/**
 * Unified channel analyzer (content-gen stage A — the accurate version).
 *
 * Combines BOTH signals in one multimodal Gemini call:
 *   - the channel's top 6-10 video TITLES + THUMBNAILS  → niche breadth
 *     (a channel-level property; one deep video mislabels it)
 *   - 1-3 full second-by-second TRANSCRIPTIONS          → recipe / format
 *     / voice / language (how they actually make videos)
 *
 * The model cross-validates: the catalog tells it the recurring format,
 * the transcriptions tell it the production method. Output is the full
 * script-ready inventory.
 *
 * Supersedes the separate niche-labeler + single-video meta-extract.
 */

import { getPool } from '../db';
import { getRandomHealthyProxy } from '../xgodo-proxy';
import { fetchViaProxy } from '../proxy-dispatcher';

const MODEL = 'gemini-2.5-flash';

export interface ChannelAnalysis {
  niche_label: string;
  niche_summary: string;
  breadth: 'single-topic' | 'broad-format';
  recipe_formula: string;
  language: string;
  is_faceless: boolean;
  production_format: string;
  voice_type: string;
  content_summary: string;
  confidence: number;
  // provenance
  sampled_videos: number;
  sampled_thumbnails: number;
  sampled_transcripts: number;
}

interface TimelineSegment {
  start?: number;
  speech_transcription?: string;
  visual_description?: string;
  audio_description?: string;
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
      await pool.query(`UPDATE xgodo_api_keys SET banned_until = NOW() + ($1 || ' seconds')::interval WHERE id = $2`, [String(seconds), keyId]);
    } catch { /* ignore */ }
  })();
}

async function fetchThumb(url: string): Promise<{ data: string; mime: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    const mime = res.headers.get('content-type') || 'image/jpeg';
    if (!mime.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 1000) return null;
    return { data: buf.toString('base64'), mime };
  } catch { return null; }
}

function transcriptToText(title: string, segments: TimelineSegment[], maxSegs: number): string {
  const lines = segments.slice(0, maxSegs).map((s) => {
    const t = s.start != null ? `[${s.start.toFixed(0)}s]` : '';
    const sp = (s.speech_transcription || '').trim();
    const vd = (s.visual_description || '').trim();
    const ad = (s.audio_description || '').trim();
    return `${t} SAY: ${sp} | SEE: ${vd} | HEAR: ${ad}`;
  });
  return `--- TRANSCRIPTION: "${title}" ---\n${lines.join('\n')}`;
}

/** Tolerant field extraction — niche_label is first + short so it
 *  survives truncation; regex-salvage if strict JSON parse fails. */
function parseAnalysis(cleaned: string): Partial<ChannelAnalysis> | null {
  try {
    return JSON.parse(cleaned) as Partial<ChannelAnalysis>;
  } catch {
    const out: Partial<ChannelAnalysis> = {};
    const str = (k: string) => cleaned.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    const lbl = str('niche_label'); if (lbl) out.niche_label = lbl[1].replace(/\\"/g, '"');
    const rec = str('recipe_formula'); if (rec) out.recipe_formula = rec[1].replace(/\\"/g, '"');
    const sum = str('niche_summary'); if (sum) out.niche_summary = sum[1].replace(/\\"/g, '"');
    const cs = str('content_summary'); if (cs) out.content_summary = cs[1].replace(/\\"/g, '"');
    const lang = str('language'); if (lang) out.language = lang[1];
    const pf = str('production_format'); if (pf) out.production_format = pf[1];
    const vt = str('voice_type'); if (vt) out.voice_type = vt[1];
    const br = cleaned.match(/"breadth"\s*:\s*"(single-topic|broad-format)"/); if (br) out.breadth = br[1] as ChannelAnalysis['breadth'];
    const fc = cleaned.match(/"is_faceless"\s*:\s*(true|false)/); if (fc) out.is_faceless = fc[1] === 'true';
    const cf = cleaned.match(/"confidence"\s*:\s*([0-9.]+)/); if (cf) out.confidence = parseFloat(cf[1]);
    return out.niche_label ? out : null;
  }
}

export async function analyzeChannelComplete(
  channelId: string,
  opts: { topN?: number; maxThumbs?: number; maxTranscripts?: number; segsPerTranscript?: number; maxAttempts?: number } = {},
): Promise<ChannelAnalysis> {
  const topN = Math.max(4, Math.min(15, opts.topN ?? 10));
  const maxThumbs = Math.max(0, Math.min(10, opts.maxThumbs ?? 8));
  const maxTranscripts = Math.max(1, Math.min(3, opts.maxTranscripts ?? 3));
  const segsPerTranscript = Math.max(40, Math.min(150, opts.segsPerTranscript ?? 90));
  const maxAttempts = opts.maxAttempts ?? 4;

  const pool = await getPool();

  // Catalog: top N live videos by views.
  const catRes = await pool.query<{ id: number; title: string | null; thumbnail: string | null; view_count: number }>(
    `SELECT id, title, thumbnail, view_count
       FROM niche_spy_videos
      WHERE channel_id = $1 AND title IS NOT NULL AND thumbnail_dead_at IS NULL
      ORDER BY view_count DESC NULLS LAST LIMIT $2`,
    [channelId, topN],
  );
  const catalog = catRes.rows.filter(v => v.title);
  if (catalog.length === 0) throw new Error(`no live titled videos for channel ${channelId}`);

  // Transcriptions: up to maxTranscripts done jobs for this channel's
  // videos, preferring the highest-viewed.
  const trRes = await pool.query<{ title: string | null; timeline_jsonb: { segments?: TimelineSegment[] } | null; view_count: number }>(
    `SELECT j.source_video_title AS title, j.timeline_jsonb, v.view_count
       FROM video_analysis_jobs j
       JOIN niche_spy_videos v ON v.id = j.video_id
      WHERE v.channel_id = $1 AND j.status = 'done' AND j.timeline_jsonb IS NOT NULL
      ORDER BY v.view_count DESC NULLS LAST
      LIMIT $2`,
    [channelId, maxTranscripts],
  );
  const transcripts = trRes.rows
    .map(t => ({ title: t.title ?? '', segs: Array.isArray(t.timeline_jsonb?.segments) ? t.timeline_jsonb!.segments! : [] }))
    .filter(t => t.segs.length > 0);

  // Thumbnails → base64 (top videos first).
  const thumbCandidates = catalog.filter(v => v.thumbnail).slice(0, maxThumbs);
  const thumbs = (await Promise.all(
    thumbCandidates.map(async v => ({ img: await fetchThumb(v.thumbnail!) })),
  )).filter(t => t.img);

  const titlesBlock = catalog.map((v, i) => `${i + 1}. "${v.title}" (${v.view_count?.toLocaleString() ?? '?'} views)`).join('\n');
  const transcriptsBlock = transcripts.length > 0
    ? transcripts.map(t => transcriptToText(t.title, t.segs, segsPerTranscript)).join('\n\n')
    : '(no transcriptions available — infer recipe/format from titles + thumbnails)';

  const promptText = `You are building a script-ready profile of a faceless YouTube channel for a content-research database. You have TWO signals:

1. CATALOG — the channel's top ${catalog.length} videos by views (titles below; ${thumbs.length} thumbnails attached as images in title order). Use this for the NICHE: capture the recurring format/theme across the whole catalog, not just one video.

2. TRANSCRIPTIONS — second-by-second breakdowns (SAY = speech, SEE = on-screen, HEAR = audio) of ${transcripts.length} of its videos. Use this for the RECIPE / production / voice / language: how they actually make a video.

CATALOG TITLES:
${titlesBlock}

${transcriptsBlock}

Produce ONLY this JSON (no prose, no fences):

{
  "niche_label": string,        // Clean 2-6 word niche a viewer recognizes & that fits a "Top 10 niches" listicle. Capture the recurring FORMAT+theme from the CATALOG, not one video's subject. e.g. "Creepy mysteries explained", "Tornado disaster documentaries", "Extinct & cryptid animals".
  "niche_summary": string,      // 1 sentence: what the channel consistently makes across its catalog.
  "breadth": string,            // "single-topic" (every video same subject) or "broad-format" (a repeatable format across many subjects).
  "recipe_formula": string,     // 1 sentence from the TRANSCRIPTIONS: the repeatable production recipe — someone could read it and replicate the format. Describe method (visuals, voice, music, editing), not just topic.
  "language": string,           // dominant spoken language: "en","en-IN","hi","ta","es","pt"...
  "is_faceless": boolean,       // true if no real human host on camera (AI/animation/stock/voiceover). A person to camera = false.
  "production_format": string,  // "ai-narration-stills"|"ai-narration-broll"|"animation"|"screen-recording"|"gameplay"|"compilation"|"talking-head"|"stock-footage-voiceover"|"slideshow"|"other"
  "voice_type": string,         // "ai-synthetic"|"human-male"|"human-female"|"multiple"|"none"
  "content_summary": string,    // 1-2 concrete sentences a researcher could read instead of watching.
  "confidence": number          // 0-1
}`;

  const parts: Array<Record<string, unknown>> = [{ text: promptText }];
  for (const t of thumbs) parts.push({ inlineData: { mimeType: t.img!.mime, data: t.img!.data } });

  let lastErr = 'unknown';
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 1500));
    const keyRow = await pickAiStudioKey();
    if (!keyRow) { lastErr = 'no active google_ai_studio key'; break; }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${keyRow.key}`;
    const body = JSON.stringify({
      contents: [{ parts }],
      generationConfig: {
        temperature: 0.3, topP: 0.9, maxOutputTokens: 2048,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const proxy = await getRandomHealthyProxy().catch(() => null);
    let res: { ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> };
    try {
      if (proxy?.url) {
        res = await fetchViaProxy(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, timeoutMs: 90_000 }, proxy.url);
      } else {
        const rr = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(90_000) });
        res = { ok: rr.ok, status: rr.status, text: () => rr.text(), json: () => rr.json() };
      }
    } catch (e) { lastErr = `connection: ${(e as Error).message}`; continue; }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      if (res.status === 429) cooloffKey(keyRow.id, 90);
      lastErr = `HTTP ${res.status}: ${errBody.slice(0, 140)}`;
      continue;
    }

    const data = await res.json().catch(() => null) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } } | null;
    if (!data || data.error) { lastErr = `gemini error: ${data?.error?.message ?? 'null'}`; continue; }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!text) { lastErr = 'empty response'; continue; }

    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const p = parseAnalysis(cleaned);
    if (!p || !p.niche_label) { lastErr = `no niche_label from: ${cleaned.slice(0, 120)}`; continue; }

    return {
      niche_label:        String(p.niche_label).trim(),
      niche_summary:      String(p.niche_summary ?? '').trim(),
      breadth:            p.breadth === 'single-topic' ? 'single-topic' : 'broad-format',
      recipe_formula:     String(p.recipe_formula ?? '').trim(),
      language:           String(p.language ?? 'en').trim(),
      is_faceless:        p.is_faceless !== false,
      production_format:  String(p.production_format ?? 'other').trim(),
      voice_type:         String(p.voice_type ?? 'none').trim(),
      content_summary:    String(p.content_summary ?? '').trim(),
      confidence:         typeof p.confidence === 'number' ? p.confidence : 0.5,
      sampled_videos:     catalog.length,
      sampled_thumbnails: thumbs.length,
      sampled_transcripts: transcripts.length,
    };
  }

  throw new Error(`unified analysis failed after ${maxAttempts} attempts: ${lastErr}`);
}
