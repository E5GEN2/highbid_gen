/**
 * Recipe showcase — transcript-grounded content highlights (Stage A.5).
 *
 * The one place in the pipeline where the VISUAL choice has to come from
 * the content itself. For the recipe section, we don't standardize the
 * visual (unlike subs/views/money cards) — we SHOW real clips of the
 * channel's own video while the narrator explains how they make it.
 *
 * Given the channel's aud/vis transcript(s) (second-by-second SAY/SEE/HEAR
 * from the video_analysis pipeline), ONE Gemini call produces paired beats:
 *
 *   { narration, video_index, clip_start, clip_end, shows }
 *
 * narration and clip are generated TOGETHER so the sentence always matches
 * the moment it points at. Every sentence is grounded ONLY in what the
 * transcript observes (no invented tools/sites) — this is the
 * anti-hallucination guardrail. clip_* are real timestamps into the source
 * video, so Stage E can extract them directly (yt-dlp + ffmpeg trim).
 *
 * Works for narration channels AND no-narration visual/music formats (most
 * of these channels) — for the latter the SEE/HEAR tracks carry it.
 */

import { getPool } from '../db';
import { getRandomHealthyProxy } from '../xgodo-proxy';
import { fetchViaProxy } from '../proxy-dispatcher';

const MODEL = 'gemini-2.5-flash';
export const RECIPE_SHOWCASE_VERSION = 1;

const MAX_VIDEOS = 2;       // showcase a couple of vids when available
const MIN_RICH_SEGS = 15;   // a "rich" transcript for moment-picking
const MAX_SEGS_PER_VIDEO = 100;

export interface ShowcaseBeat {
  narration: string;
  video_index: number;          // 1-based, into source_videos
  source_video_id: number;
  source_video_url: string | null;
  clip_start: number;           // seconds, snapped to a real segment
  clip_end: number;             // seconds
  shows: string;                // label of what the clip demonstrates
}

export interface RecipeShowcase {
  channel_id: string;
  recipe_summary: string;
  beats: ShowcaseBeat[];
  source_video_ids: number[];
  model: string;
  version: number;
  cached: boolean;
}

interface TimelineSegment {
  start?: number;
  speech_transcription?: string;
  visual_description?: string;
  audio_description?: string;
}

interface SourceVideo {
  video_id: number;
  url: string | null;
  title: string;
  segs: TimelineSegment[];
  duration: number;
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

/** Evenly sample to a segment cap, keeping the head and tail intact. */
function sampleSegs(segs: TimelineSegment[], cap = MAX_SEGS_PER_VIDEO): TimelineSegment[] {
  if (segs.length <= cap) return segs;
  const head = segs.slice(0, 6);
  const tail = segs.slice(-4);
  const mid: TimelineSegment[] = [];
  const step = segs.length / (cap - 10);
  for (let i = 6; i < segs.length - 4; i += step) mid.push(segs[Math.floor(i)]);
  return [...head, ...mid, ...tail];
}

function transcriptBlock(segs: TimelineSegment[]): string {
  return sampleSegs(segs).map((s) => {
    const t = s.start != null ? Number(s.start).toFixed(1) : '?';
    const say = (s.speech_transcription || '').trim();
    const see = (s.visual_description || '').trim().slice(0, 160);
    const hear = (s.audio_description || '').trim().slice(0, 80);
    return `[${t}s] SAY:${say || '—'} | SEE:${see} | HEAR:${hear}`;
  }).join('\n');
}

function buildPrompt(niche: string, recipe: string, videos: SourceVideo[]): string {
  const videoBlocks = videos.map((v, i) =>
    `=== VIDEO ${i + 1} (refer to this as "video_index": ${i + 1}) — "${v.title}" (${v.duration.toFixed(0)}s) ===\n${transcriptBlock(v.segs)}`,
  ).join('\n\n');

  return `You are designing the "recipe showcase" portion of a faceless-YouTube "hidden niches" listicle video (calm male documentary narrator, "Money Groot" style). In this part we SHOW short clips of the channel's ACTUAL video(s) while the narrator explains, in concrete terms, HOW this channel makes its content — so a viewer thinks "I could do this."

CHANNEL NICHE: ${niche}
KNOWN RECIPE (rough): ${recipe}

Below ${videos.length === 1 ? 'is the second-by-second transcript of one of the channel\'s videos' : `are the second-by-second transcripts of ${videos.length} of the channel's videos`}. SAY = spoken words (often EMPTY — many of these channels have NO narration, only visuals + music), SEE = what's on screen, HEAR = music/sfx.

${videoBlocks}

Produce 4-6 paired beats. Each beat = ONE narration sentence the host says, plus the EXACT clip moment whose visuals best demonstrate what that sentence describes. The narration and the clip MUST match.

HARD RULES:
- Ground EVERY sentence ONLY in what is observable in the transcript (SEE/HEAR/SAY). Do NOT invent tools, websites, software names, or facts not present in the transcript.
- Cover DIFFERENT aspects across the beats: (1) how a video opens / the hook, (2) the core visual mechanic that defines the format, (3) the audio / music style, (4) the climax or payoff. Skip any that don't apply.
- If there is no speech, the narration explains what the VIEWER SEES and HEARS — for these channels, that IS the recipe.
- clip_start / clip_end must be real timestamps that appear in the cited video's transcript; clips 2-4s long; non-overlapping; chronological within a video.
- "video_index" must be 1${videos.length > 1 ? ` or up to ${videos.length}` : ''} and the clip times must belong to THAT video.
- Narration: calm, concrete, "This channel...", "They...", present tense, 12-22 words, no hype.

Return ONLY JSON (no prose, no fences):
{
  "recipe_summary": "one sentence: the repeatable production recipe a viewer could follow",
  "beats": [
    { "narration": "...", "video_index": 1, "clip_start": 0.0, "clip_end": 3.0, "shows": "short label of what this clip demonstrates" }
  ]
}`;
}

/** Pull a JSON object from possibly-fenced/prose-wrapped Gemini text. */
function looseParse(text: string): { recipe_summary?: string; beats?: unknown[] } | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { return JSON.parse(cleaned); } catch { /* salvage */ }
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
  return null;
}

/** Snap a requested time to the nearest real segment start in the video. */
function snapToSegment(t: number, segStarts: number[]): number {
  if (segStarts.length === 0) return t;
  let best = segStarts[0], bestD = Math.abs(t - best);
  for (const s of segStarts) { const d = Math.abs(t - s); if (d < bestD) { best = s; bestD = d; } }
  return best;
}

async function pullSourceVideos(channelId: string): Promise<SourceVideo[]> {
  const pool = await getPool();
  const r = await pool.query<{ video_id: number; url: string | null; title: string | null; timeline_jsonb: { segments?: TimelineSegment[]; video_duration_seconds?: number } | null }>(
    `SELECT v.id AS video_id, v.url, j.source_video_title AS title, j.timeline_jsonb
       FROM video_analysis_jobs j
       JOIN niche_spy_videos v ON v.id = j.video_id
      WHERE v.channel_id = $1 AND j.status = 'done' AND j.timeline_jsonb IS NOT NULL
      ORDER BY v.view_count DESC NULLS LAST
      LIMIT 4`,
    [channelId],
  );
  const candidates: SourceVideo[] = r.rows.map((row) => {
    const segs = Array.isArray(row.timeline_jsonb?.segments) ? row.timeline_jsonb!.segments! : [];
    const lastStart = segs.length ? Number(segs[segs.length - 1].start ?? 0) : 0;
    return {
      video_id: row.video_id,
      url: row.url,
      title: row.title ?? '',
      segs,
      duration: Number(row.timeline_jsonb?.video_duration_seconds ?? lastStart) || lastStart,
    };
  }).filter(v => v.segs.length > 0);

  // Prefer rich transcripts (more segments → better moment-picking), but
  // keep the highest-viewed first. Take up to MAX_VIDEOS; if none meet the
  // richness floor, fall back to whatever exists (thin music-edit channels).
  const rich = candidates.filter(v => v.segs.length >= MIN_RICH_SEGS);
  const chosen = (rich.length > 0 ? rich : candidates).slice(0, MAX_VIDEOS);
  return chosen;
}

export async function generateRecipeShowcase(channelId: string): Promise<RecipeShowcase> {
  const pool = await getPool();

  const videos = await pullSourceVideos(channelId);
  if (videos.length === 0) throw new Error(`no usable transcripts for channel ${channelId}`);

  const an = (await pool.query<{ niche_label: string | null; recipe_formula: string | null }>(
    `SELECT niche_label, recipe_formula FROM content_gen_channel_analysis WHERE channel_id = $1`,
    [channelId],
  )).rows[0] ?? null;
  const niche = an?.niche_label ?? '(unknown niche)';
  const recipe = an?.recipe_formula ?? '(unknown)';

  const prompt = buildPrompt(niche, recipe, videos);

  let lastErr = 'unknown';
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 1500));
    const keyRow = await pickAiStudioKey();
    if (!keyRow) { lastErr = 'no active google_ai_studio key'; break; }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${keyRow.key}`;
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.4, topP: 0.9, maxOutputTokens: 2048,
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
    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('') ?? '';
    if (!text) { lastErr = 'empty response'; continue; }

    const parsed = looseParse(text);
    if (!parsed || !Array.isArray(parsed.beats)) { lastErr = `parse: ${text.slice(0, 120)}`; continue; }

    // Validate + snap each beat to its source video.
    const beats: ShowcaseBeat[] = [];
    for (const raw of parsed.beats as Array<Record<string, unknown>>) {
      const vi = Math.round(Number(raw.video_index));
      const idx = Number.isFinite(vi) && vi >= 1 && vi <= videos.length ? vi : 1;
      const v = videos[idx - 1];
      const narration = String(raw.narration ?? '').trim();
      if (!narration) continue;
      const segStarts = v.segs.map(s => Number(s.start ?? 0));
      let cs = Number(raw.clip_start);
      let ce = Number(raw.clip_end);
      if (!Number.isFinite(cs)) cs = 0;
      cs = snapToSegment(Math.max(0, cs), segStarts);
      let dur = Number.isFinite(ce) ? ce - cs : 3;
      if (!(dur >= 1.5 && dur <= 5)) dur = 3;
      ce = Math.min(v.duration || cs + dur, cs + Math.min(4.5, Math.max(2, dur)));
      if (ce <= cs) ce = cs + 2.5;
      beats.push({
        narration,
        video_index: idx,
        source_video_id: v.video_id,
        source_video_url: v.url,
        clip_start: Math.round(cs * 10) / 10,
        clip_end: Math.round(ce * 10) / 10,
        shows: String(raw.shows ?? '').trim(),
      });
    }
    if (beats.length === 0) { lastErr = 'no valid beats'; continue; }

    const result: RecipeShowcase = {
      channel_id: channelId,
      recipe_summary: String(parsed.recipe_summary ?? '').trim(),
      beats,
      source_video_ids: videos.map(v => v.video_id),
      model: MODEL,
      version: RECIPE_SHOWCASE_VERSION,
      cached: false,
    };

    await pool.query(
      `INSERT INTO content_gen_recipe_showcase (channel_id, source_video_ids, recipe_summary, beats_jsonb, n_beats, model, version, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
       ON CONFLICT (channel_id) DO UPDATE SET
         source_video_ids = EXCLUDED.source_video_ids, recipe_summary = EXCLUDED.recipe_summary,
         beats_jsonb = EXCLUDED.beats_jsonb, n_beats = EXCLUDED.n_beats, model = EXCLUDED.model,
         version = EXCLUDED.version, updated_at = NOW()`,
      [channelId, result.source_video_ids, result.recipe_summary, JSON.stringify(result.beats), beats.length, MODEL, RECIPE_SHOWCASE_VERSION],
    );
    return result;
  }
  throw new Error(`recipe showcase failed for ${channelId}: ${lastErr}`);
}

export async function getOrGenerateRecipeShowcase(channelId: string, force = false): Promise<RecipeShowcase> {
  if (!force) {
    const pool = await getPool();
    const c = await pool.query<{ source_video_ids: number[]; recipe_summary: string; beats_jsonb: ShowcaseBeat[]; model: string; version: number }>(
      `SELECT source_video_ids, recipe_summary, beats_jsonb, model, version
         FROM content_gen_recipe_showcase WHERE channel_id = $1`,
      [channelId],
    );
    if (c.rows[0]) {
      const row = c.rows[0];
      return {
        channel_id: channelId,
        recipe_summary: row.recipe_summary,
        beats: Array.isArray(row.beats_jsonb) ? row.beats_jsonb : [],
        source_video_ids: row.source_video_ids ?? [],
        model: row.model, version: row.version, cached: true,
      };
    }
  }
  return generateRecipeShowcase(channelId);
}
