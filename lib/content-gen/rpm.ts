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
