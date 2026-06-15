/**
 * Per-niche RPM estimation + cache.
 *
 * RPM (revenue per 1000 views, USD) is what turns a channel's view counts
 * into the money figures the script delivers ($/year, $/month, $/video).
 * It's primarily a function of the content CATEGORY (advertiser demand /
 * CPM) and the audience geography — finance/tech pull high RPM, gaming/
 * kids pull low, general edutainment sits in the middle.
 *
 * We ask Gemini for a {low, typical, high} RPM per niche and cache it
 * (content_gen_rpm_cache) keyed on (normalized niche, geo). RPM is stable
 * per niche so caching avoids re-paying per generation.
 *
 * Reuses the google_ai_studio key pool + proxy egress.
 */

import { getPool } from '../db';
import { getRandomHealthyProxy } from '../xgodo-proxy';
import { fetchViaProxy } from '../proxy-dispatcher';

const MODEL = 'gemini-2.5-flash';

export interface RpmEstimate {
  rpm_low: number;
  rpm_typical: number;
  rpm_high: number;
  reasoning: string;
  /** Short MG-style voiceover clause justifying the rpm ("because the topic
   *  is business and most viewers are from the US"), nested into the money-
   *  math sentence. May be '' for legacy rows not yet re-analyzed. */
  spoken_reason?: string;
}

export interface CachedRpm extends RpmEstimate {
  niche_key: string;
  geo: string;
  niche_label: string;
  cached: boolean;
}

function nicheKey(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 120);
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

const GEO_LABEL: Record<string, string> = {
  en: 'a typical English-speaking audience (a mix of US, UK, Canada, Australia)',
  us: 'a primarily United States audience',
  uk: 'a primarily United Kingdom audience',
  in: 'a primarily Indian audience',
  global: 'a globally-mixed audience (heavy tier-2/tier-3 weighting)',
};

async function estimateRpm(nicheLabel: string, geo: string, maxAttempts = 4): Promise<RpmEstimate> {
  const audience = GEO_LABEL[geo] ?? GEO_LABEL.en;
  const prompt = `You are a YouTube monetization analyst. Estimate the realistic YouTube AdSense RPM — net revenue the creator receives per 1000 monetized views, in USD — for a FACELESS YouTube channel in this niche, for ${audience}.

NICHE: "${nicheLabel}"

Consider the niche's advertiser demand / CPM tier: finance, business, tech, software, insurance, legal = high; education, documentary, history, science = upper-mid; general entertainment, motivation, storytelling = mid; gaming, memes, compilations, kids = low. Long-form (8min+) videos with mid-roll ads earn more than shorts.

Give the creator's NET RPM (after YouTube's 45% cut) — i.e. what actually lands in their pocket per 1000 views, NOT the gross CPM advertisers pay.

Produce ONLY this JSON (no prose, no fences):

{
  "rpm_low": number,      // conservative net RPM in USD (e.g. 1.5)
  "rpm_typical": number,  // most likely net RPM in USD
  "rpm_high": number,     // optimistic net RPM in USD
  "reasoning": string     // 1 sentence: the CPM tier + why
}`;

  let lastErr = 'unknown';
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 1500));
    const keyRow = await pickAiStudioKey();
    if (!keyRow) { lastErr = 'no active google_ai_studio key'; break; }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${keyRow.key}`;
    const body = JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2, topP: 0.9, maxOutputTokens: 512,
        responseMimeType: 'application/json',
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    const proxy = await getRandomHealthyProxy().catch(() => null);
    let res: { ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> };
    try {
      if (proxy?.url) {
        res = await fetchViaProxy(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, timeoutMs: 60_000 }, proxy.url);
      } else {
        const rr = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(60_000) });
        res = { ok: rr.ok, status: rr.status, text: () => rr.text(), json: () => rr.json() };
      }
    } catch (e) { lastErr = `connection: ${(e as Error).message}`; continue; }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      if (res.status === 429) cooloffKey(keyRow.id, 90);
      lastErr = `HTTP ${res.status}: ${errBody.slice(0, 120)}`;
      continue;
    }

    const data = await res.json().catch(() => null) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } } | null;
    if (!data || data.error) { lastErr = `gemini error: ${data?.error?.message ?? 'null'}`; continue; }
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!text) { lastErr = 'empty response'; continue; }

    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    let p: Partial<RpmEstimate>;
    try { p = JSON.parse(cleaned) as Partial<RpmEstimate>; }
    catch (e) { lastErr = `JSON parse: ${(e as Error).message}`; continue; }

    const low = Number(p.rpm_low), typ = Number(p.rpm_typical), high = Number(p.rpm_high);
    if (![low, typ, high].every(n => Number.isFinite(n) && n >= 0 && n < 200)) {
      lastErr = `implausible rpm values: ${JSON.stringify(p)}`;
      continue;
    }
    return {
      rpm_low:     Math.round(low * 100) / 100,
      rpm_typical: Math.round(typ * 100) / 100,
      rpm_high:    Math.round(high * 100) / 100,
      reasoning:   String(p.reasoning ?? '').trim(),
    };
  }
  throw new Error(`RPM estimation failed after ${maxAttempts} attempts: ${lastErr}`);
}

// ─────────────────────────────────────────────────────────────────────
// Per-CHANNEL RPM (the accurate path — grounds on the actual channel).
// ─────────────────────────────────────────────────────────────────────

export interface ChannelRpm extends RpmEstimate {
  channel_id: string;
  channel_url: string;
  video_url: string | null;
  niche_label: string;
  geo_guess: string;
  /** What Gemini consumed: 'video' (watched the top video) | 'context' (fell back) */
  grounded_on: string;
  url_fetched: boolean; // legacy column; true when grounded_on='video'
  cached: boolean;
}

/** Pull a number out of possibly-fenced / prose-wrapped Gemini text. */
function looseParseRpm(text: string): Partial<RpmEstimate & { geo_guess: string }> | null {
  // Find the first {...} JSON object in the text.
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { /* fall through */ }
  // Last-ditch: regex the numbers.
  const num = (k: string) => {
    const mm = text.match(new RegExp(`"${k}"\\s*:\\s*([0-9.]+)`));
    return mm ? parseFloat(mm[1]) : undefined;
  };
  const lo = num('rpm_low'), ty = num('rpm_typical'), hi = num('rpm_high');
  if (lo == null && ty == null && hi == null) return null;
  const geoM = text.match(/"geo_guess"\s*:\s*"([^"]*)"/);
  const reasM = text.match(/"reasoning"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  const sreasM = text.match(/"spoken_reason"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  return { rpm_low: lo, rpm_typical: ty, rpm_high: hi, geo_guess: geoM?.[1], reasoning: reasM?.[1], spoken_reason: sreasM?.[1] };
}

/** Normalize the spoken RPM reason into a mid-sentence clause: collapse
 *  whitespace, ensure it leads with "because"/"since", lowercase the first
 *  word, drop trailing punctuation (the builder adds the comma), cap length.
 *  Returns '' when there's nothing usable. */
function normalizeSpokenReason(raw: string | undefined | null): string {
  let s = String(raw ?? '').replace(/\s+/g, ' ').trim().replace(/[.,;:\s]+$/, '');
  if (!s) return '';
  if (!/^(because|since)\b/i.test(s)) s = `because ${s}`;
  s = s.charAt(0).toLowerCase() + s.slice(1);
  const words = s.split(' ');
  if (words.length > 18) s = words.slice(0, 18).join(' ');
  return s;
}

/**
 * Estimate RPM for a specific channel. Builds the channel URL, gives
 * Gemini the url_context tool to read it, and supplies our extracted
 * context (niche, catalog titles, subs) as grounding regardless of
 * whether the fetch succeeds.
 */
export async function getOrEstimateChannelRpm(channelId: string, force = false): Promise<ChannelRpm> {
  const pool = await getPool();

  if (!force) {
    const c = await pool.query<{ channel_url: string; video_url: string | null; niche_label: string; geo_guess: string; rpm_low: number; rpm_typical: number; rpm_high: number; reasoning: string; grounded_on: string | null; url_fetched: boolean }>(
      `SELECT channel_url, video_url, niche_label, geo_guess, rpm_low, rpm_typical, rpm_high, reasoning, grounded_on, url_fetched
         FROM content_gen_channel_rpm WHERE channel_id = $1`,
      [channelId],
    );
    if (c.rows[0]) {
      const row = c.rows[0];
      return { channel_id: channelId, ...row, grounded_on: row.grounded_on ?? 'context', cached: true };
    }
  }

  // Gather channel context.
  const chRes = await pool.query<{ channel_handle: string | null; subscriber_count: number | null }>(
    `SELECT channel_handle, subscriber_count FROM niche_spy_channels WHERE channel_id = $1`,
    [channelId],
  );
  const handle = chRes.rows[0]?.channel_handle ?? null;
  const subs = chRes.rows[0]?.subscriber_count ?? null;
  const channelUrl = handle
    ? `https://www.youtube.com/${handle.startsWith('@') ? handle : '@' + handle}`
    : `https://www.youtube.com/channel/${channelId}`;

  const anRes = await pool.query<{ niche_label: string | null; language: string | null }>(
    `SELECT niche_label, language FROM content_gen_channel_analysis WHERE channel_id = $1`,
    [channelId],
  );
  const niche = anRes.rows[0]?.niche_label ?? '(unknown niche)';
  const language = anRes.rows[0]?.language ?? 'en';

  // Top live video (the one Gemini will watch).
  const vidRes = await pool.query<{ url: string | null; title: string | null }>(
    `SELECT url, title FROM niche_spy_videos
      WHERE channel_id = $1 AND url IS NOT NULL AND thumbnail_dead_at IS NULL
      ORDER BY view_count DESC NULLS LAST LIMIT 1`,
    [channelId],
  );
  const videoUrl = vidRes.rows[0]?.url ?? null;

  const titlesRes = await pool.query<{ title: string }>(
    `SELECT title FROM niche_spy_videos
      WHERE channel_id = $1 AND title IS NOT NULL AND thumbnail_dead_at IS NULL
      ORDER BY view_count DESC NULLS LAST LIMIT 10`,
    [channelId],
  );
  const titles = titlesRes.rows.map((t, i) => `${i + 1}. ${t.title}`).join('\n');

  const prompt = `You are a YouTube monetization analyst estimating a channel's AdSense RPM (net USD the creator receives per 1000 monetized views, AFTER YouTube's 45% cut).

${videoUrl ? `WATCH the attached video — it is the channel's top video. Judge its content category, advertiser-friendliness (graphic/controversial content lowers RPM), production style, and the likely audience.\n\n` : ''}What we already know about the channel:
- Niche: ${niche}
- Spoken language: ${language}
- Subscribers: ${subs?.toLocaleString() ?? 'unknown'}
- Top video titles:
${titles}

Estimate the RPM grounded in this channel — its actual content category (advertiser CPM tier: finance/tech/business high; education/history/science upper-mid; general entertainment/motivation mid; gaming/memes/compilations/kids low) AND its likely audience geography (US/UK/CA/AU = high value; India/SEA/LatAm = much lower). Audience geo is often the single biggest RPM factor.

Respond with ONLY a JSON object:
{
  "rpm_low": number,      // conservative NET RPM USD
  "rpm_typical": number,  // most likely NET RPM USD
  "rpm_high": number,     // optimistic NET RPM USD
  "geo_guess": string,    // inferred dominant audience geo, e.g. "US/UK", "India", "global-mixed"
  "reasoning": string,    // 1 sentence: CPM tier + geo + (if watched) what the video showed
  "spoken_reason": string // SHORT voiceover clause, MAX 14 words, that justifies THIS rpm. Start lowercase with "because" or "since", name the 1-2 STRONGEST drivers for this channel (content category/topic, video length, spoken language, audience geography) — vary it per channel, never generic. It MUST read naturally mid-sentence: "...a $4 RPM, {spoken_reason}, that translates to...". Examples: "because the topic is business and most viewers are from the US", "since these are long explainer videos in English"
}`;

  // Try video-grounded first (watch first 3 min of the top video). On a
  // video-processing failure, fall back to a context-only estimate.
  let lastErr = 'unknown';
  for (const mode of (videoUrl ? ['video', 'context'] : ['context']) as Array<'video' | 'context'>) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 1500));
      const keyRow = await pickAiStudioKey();
      if (!keyRow) { lastErr = 'no active google_ai_studio key'; break; }

      const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${keyRow.key}`;
      const parts: Array<Record<string, unknown>> = [{ text: prompt }];
      if (mode === 'video' && videoUrl) {
        // Watch only the first 3 minutes — enough to judge category +
        // ad-friendliness, keeps token cost bounded.
        parts.push({ fileData: { fileUri: videoUrl }, videoMetadata: { startOffset: '0s', endOffset: '180s' } });
      }
      const body = JSON.stringify({
        contents: [{ parts }],
        generationConfig: {
          temperature: 0.2, topP: 0.9, maxOutputTokens: 1024,
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 0 },
        },
      });

      const proxy = await getRandomHealthyProxy().catch(() => null);
      let res: { ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> };
      try {
        if (proxy?.url) {
          res = await fetchViaProxy(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, timeoutMs: 120_000 }, proxy.url);
        } else {
          const rr = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(120_000) });
          res = { ok: rr.ok, status: rr.status, text: () => rr.text(), json: () => rr.json() };
        }
      } catch (e) { lastErr = `connection(${mode}): ${(e as Error).message}`; continue; }

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        if (res.status === 429) cooloffKey(keyRow.id, 90);
        // A 400 on the video path usually means the video can't be
        // processed (private/blocked/too long) — break to the context
        // fallback rather than retrying the same bad video.
        if (res.status === 400 && mode === 'video') { lastErr = `video 400: ${errBody.slice(0, 100)}`; break; }
        lastErr = `HTTP ${res.status}(${mode}): ${errBody.slice(0, 100)}`;
        continue;
      }

      const data = await res.json().catch(() => null) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; error?: { message?: string } } | null;
      if (!data || data.error) { lastErr = `gemini error(${mode}): ${data?.error?.message ?? 'null'}`; continue; }
      const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('\n') ?? '';
      if (!text) { lastErr = `empty(${mode})`; continue; }

      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
      const p = looseParseRpm(cleaned);
      const low = Number(p?.rpm_low), typ = Number(p?.rpm_typical), high = Number(p?.rpm_high);
      if (!p || ![low, typ, high].every(n => Number.isFinite(n) && n >= 0 && n < 200)) {
        lastErr = `implausible/parse(${mode}): ${cleaned.slice(0, 120)}`;
        continue;
      }

      const result: ChannelRpm = {
        channel_id: channelId, channel_url: channelUrl, video_url: mode === 'video' ? videoUrl : null,
        niche_label: niche, geo_guess: String(p.geo_guess ?? '').trim() || 'unknown',
        rpm_low: Math.round(low * 100) / 100, rpm_typical: Math.round(typ * 100) / 100, rpm_high: Math.round(high * 100) / 100,
        reasoning: String(p.reasoning ?? '').trim(),
        spoken_reason: normalizeSpokenReason((p as { spoken_reason?: string }).spoken_reason),
        grounded_on: mode, url_fetched: mode === 'video', cached: false,
      };
      await pool.query(
        `INSERT INTO content_gen_channel_rpm (channel_id, channel_url, video_url, niche_label, geo_guess, rpm_low, rpm_typical, rpm_high, reasoning, spoken_reason, grounded_on, url_fetched, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW())
         ON CONFLICT (channel_id) DO UPDATE SET
           channel_url = EXCLUDED.channel_url, video_url = EXCLUDED.video_url, niche_label = EXCLUDED.niche_label,
           geo_guess = EXCLUDED.geo_guess, rpm_low = EXCLUDED.rpm_low, rpm_typical = EXCLUDED.rpm_typical,
           rpm_high = EXCLUDED.rpm_high, reasoning = EXCLUDED.reasoning, spoken_reason = EXCLUDED.spoken_reason,
           grounded_on = EXCLUDED.grounded_on, url_fetched = EXCLUDED.url_fetched, updated_at = NOW()`,
        [channelId, channelUrl, result.video_url, niche, result.geo_guess, result.rpm_low, result.rpm_typical, result.rpm_high, result.reasoning, result.spoken_reason ?? '', mode, result.url_fetched],
      );
      return result;
    }
  }
  throw new Error(`channel RPM estimation failed: ${lastErr}`);
}

/**
 * Get the RPM for a niche, from cache if present (and not forced), else
 * estimate via Gemini + persist.
 */
export async function getOrEstimateRpm(nicheLabel: string, geo = 'en', force = false): Promise<CachedRpm> {
  const key = nicheKey(nicheLabel);
  const pool = await getPool();

  if (!force) {
    const c = await pool.query<{ niche_label: string; rpm_low: number; rpm_typical: number; rpm_high: number; reasoning: string }>(
      `SELECT niche_label, rpm_low, rpm_typical, rpm_high, reasoning
         FROM content_gen_rpm_cache WHERE niche_key = $1 AND geo = $2`,
      [key, geo],
    );
    if (c.rows[0]) {
      return {
        niche_key: key, geo, niche_label: c.rows[0].niche_label,
        rpm_low: c.rows[0].rpm_low, rpm_typical: c.rows[0].rpm_typical,
        rpm_high: c.rows[0].rpm_high, reasoning: c.rows[0].reasoning, cached: true,
      };
    }
  }

  const est = await estimateRpm(nicheLabel, geo);
  await pool.query(
    `INSERT INTO content_gen_rpm_cache (niche_key, geo, niche_label, rpm_low, rpm_typical, rpm_high, reasoning, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())
     ON CONFLICT (niche_key, geo) DO UPDATE SET
       niche_label = EXCLUDED.niche_label, rpm_low = EXCLUDED.rpm_low,
       rpm_typical = EXCLUDED.rpm_typical, rpm_high = EXCLUDED.rpm_high,
       reasoning = EXCLUDED.reasoning, updated_at = NOW()`,
    [key, geo, nicheLabel, est.rpm_low, est.rpm_typical, est.rpm_high, est.reasoning],
  );
  return { niche_key: key, geo, niche_label: nicheLabel, ...est, cached: false };
}
