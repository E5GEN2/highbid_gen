/**
 * Content-gen meta-extraction (stage A, step 2).
 *
 * Takes the full second-by-second timeline a transcription job produces
 * and distills it — via ONE Gemini text call over the transcription —
 * into the clean, structured data inventory the listicle generator
 * needs:
 *
 *   { niche_label, recipe_formula, language, is_faceless,
 *     production_format, voice_type, content_summary, confidence }
 *
 * niche_label is the hero field: it replaces the garbage cluster
 * auto-labels ("sleep history sleep history") with a name a human would
 * actually title a niche ("Sumerian history & ancient tablets").
 *
 * Reuses the same google_ai_studio key pool + proxy egress as the rest
 * of the platform's Gemini traffic (mirrors lib/vid-gen-runner.ts).
 */

import { getPool } from '../db';
import { getRandomHealthyProxy } from '../xgodo-proxy';
import { fetchViaProxy } from '../proxy-dispatcher';

const META_MODEL = 'gemini-2.5-flash';

export interface ChannelMetaAnalysis {
  niche_label: string;
  recipe_formula: string;
  language: string;
  is_faceless: boolean;
  production_format: string;
  voice_type: string;
  content_summary: string;
  confidence: number;
}

/** Shape of one timeline segment (subset we care about). */
interface TimelineSegment {
  start?: number;
  end?: number;
  speech_transcription?: string;
  visual_description?: string;
  audio_description?: string;
}

interface TimelineJson {
  segments?: TimelineSegment[];
  source_video?: string;
  video_duration_seconds?: number;
  [k: string]: unknown;
}

function buildMetaPrompt(title: string, durationS: number | null, segments: TimelineSegment[]): string {
  // Cap the segments we feed in to keep token cost bounded. The first
  // ~120 segments (≈6 min at ~3s/seg) carry more than enough signal for
  // niche + recipe + language; the tail is repetitive for our purpose.
  const capped = segments.slice(0, 120);
  const transcriptLines = capped.map((s) => {
    const t = s.start != null ? `[${s.start.toFixed(0)}s]` : '';
    const sp = (s.speech_transcription || '').trim();
    const vd = (s.visual_description || '').trim();
    const ad = (s.audio_description || '').trim();
    return `${t} SAY: ${sp}\n     SEE: ${vd}\n     HEAR: ${ad}`;
  }).join('\n');

  return `You are analyzing ONE YouTube video to extract structured metadata for a content-research database. Below is a second-by-second transcription of the video — what's said (SAY), what's on screen (SEE), and the audio (HEAR).

VIDEO TITLE: ${title}
DURATION: ${durationS != null ? `${Math.round(durationS)}s` : 'unknown'}

TRANSCRIPTION:
${transcriptLines}

Produce ONLY this JSON (no prose, no markdown fences):

{
  "niche_label": string,        // Clean, human-readable 2-5 word niche name a viewer would recognize. NOT keyword soup. e.g. "Sumerian history & ancient tablets", "Deep-sea creature facts", "Healing frequency music". This becomes the niche name in a "Top 10 niches" listicle — make it a name a human would actually title a niche.
  "recipe_formula": string,     // ONE sentence: exactly how this channel makes a video, as a repeatable production recipe. e.g. "Narrates ancient Sumerian texts over AI-generated images of tablets and ruins with ambient music." Describe the PRODUCTION METHOD, not just the topic.
  "language": string,           // BCP-47-ish dominant spoken language: "en", "en-IN", "hi", "ta", "es", "pt", etc.
  "is_faceless": boolean,       // true if NO real human host presents to camera. AI avatars, animation, screen-rec, stock footage, pure voiceover = faceless. A real person talking to camera = false.
  "production_format": string,  // one of: "ai-narration-stills" | "ai-narration-broll" | "animation" | "screen-recording" | "gameplay" | "compilation" | "talking-head" | "stock-footage-voiceover" | "slideshow" | "other"
  "voice_type": string,         // one of: "ai-synthetic" | "human-male" | "human-female" | "multiple" | "none"
  "content_summary": string,    // 1-2 concrete sentences a researcher could read to understand the channel without watching. No fluff.
  "confidence": number          // 0-1: your confidence in niche_label + recipe_formula given this single video's signal.
}

Rules:
- niche_label is the MOST important field. Make it a real niche name, not extracted keywords.
- recipe_formula must be copyable — someone reads it and understands how to replicate the format.
- Be decisive on is_faceless and voice_type.`;
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

function invalidateKey(keyId: number, reason: string): void {
  void (async () => {
    try {
      const pool = await getPool();
      await pool.query(
        `UPDATE xgodo_api_keys SET status = 'invalid', invalidated_at = NOW() WHERE id = $1 AND status = 'active'`,
        [keyId],
      );
      console.log(`[content-gen/meta] invalidated key id=${keyId} (${reason})`);
    } catch { /* ignore */ }
  })();
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

/**
 * Run meta-extraction over a timeline. Retries up to `maxAttempts` with
 * fresh keys on transient failures.
 */
export async function extractChannelMeta(
  timeline: TimelineJson,
  videoTitle: string,
  opts: { maxAttempts?: number } = {},
): Promise<ChannelMetaAnalysis> {
  const segments = Array.isArray(timeline.segments) ? timeline.segments : [];
  if (segments.length === 0) {
    throw new Error('timeline has no segments to analyze');
  }
  const prompt = buildMetaPrompt(
    videoTitle,
    timeline.video_duration_seconds ?? null,
    segments,
  );
  const maxAttempts = opts.maxAttempts ?? 4;

  let lastErr = 'unknown';
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const keyRow = await pickAiStudioKey();
    if (!keyRow) { lastErr = 'no active google_ai_studio key'; break; }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${META_MODEL}:generateContent?key=${keyRow.key}`;
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3, topP: 0.9, maxOutputTokens: 2048,
        responseMimeType: 'application/json',
        // Disable gemini-2.5-flash thinking — it eats the output budget
        // and this is a straightforward extraction task.
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
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: AbortSignal.timeout(60_000),
        });
        res = { ok: r.ok, status: r.status, text: () => r.text(), json: () => r.json() };
      }
    } catch (e) {
      lastErr = `connection: ${(e as Error).message}`;
      continue;
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      if (res.status === 403 && /PERMISSION_DENIED|denied|suspended/i.test(errBody)) {
        invalidateKey(keyRow.id, `403: ${errBody.slice(0, 80)}`);
      }
      if (res.status === 429) cooloffKey(keyRow.id, 90);
      lastErr = `HTTP ${res.status}: ${errBody.slice(0, 160)}`;
      continue;
    }

    const data = await res.json().catch(() => null) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      error?: { message?: string };
    } | null;
    if (!data || data.error) { lastErr = `gemini error: ${data?.error?.message ?? 'null body'}`; continue; }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!text) { lastErr = 'empty response'; continue; }

    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    let parsed: Partial<ChannelMetaAnalysis>;
    try {
      parsed = JSON.parse(cleaned) as Partial<ChannelMetaAnalysis>;
    } catch (e) {
      lastErr = `JSON parse: ${(e as Error).message} — got: ${cleaned.slice(0, 120)}`;
      continue;
    }

    // Validate the load-bearing fields.
    if (!parsed.niche_label || !parsed.recipe_formula) {
      lastErr = `missing niche_label/recipe_formula in: ${cleaned.slice(0, 120)}`;
      continue;
    }

    return {
      niche_label:       String(parsed.niche_label).trim(),
      recipe_formula:    String(parsed.recipe_formula).trim(),
      language:          String(parsed.language ?? 'en').trim(),
      is_faceless:       parsed.is_faceless !== false,
      production_format: String(parsed.production_format ?? 'other').trim(),
      voice_type:        String(parsed.voice_type ?? 'none').trim(),
      content_summary:   String(parsed.content_summary ?? '').trim(),
      confidence:        typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
    };
  }

  throw new Error(`meta-extraction failed after ${maxAttempts} attempts: ${lastErr}`);
}
