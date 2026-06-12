/**
 * Channel-B relationship verification — classifies a KNN candidate
 * against the hero channel on TWO axes (format, subject) so the
 * channel_b_proof / saturation_callout narration never overclaims.
 *
 * Why (user report 2026-06-12): embedding similarity alone surfaced
 * channels that share the hero's subject world (fictional monsters)
 * but NOT its format (explainer countdowns vs size-comparison lineups)
 * — and the narration said "the same kind of videos" over them.
 *
 * MG's own grammar (transcript, all 8 channel_b instances): the
 * SIMILARITY is always a fixed cheap phrase, the DIFFERENCE is the only
 * specific content (2-4 words) —
 *   "doing this exact style with Clash Royale"          (same fmt, diff subject)
 *   "makes videos only on The Matrix movie"             (same fmt, narrower)
 *   "started uploading similar content"                 (fuzzy hedge, n8)
 * The classifier returns the axes + the short deltas; narration comes
 * from the fixed matrix in `relationTail()` — no free-form prose ever
 * reaches the voice track.
 *
 * Evidence = video TITLES (KNN candidates are in-corpus by construction,
 * so titles are already in niche_spy_videos — zero new fetches). Verdicts
 * cache forever per (hero, candidate) in content_gen_channel_relationships.
 */

import pg from 'pg';

// Evidence + cache live on the MAIN DB (HB_RAILWAY_DB_URL when set —
// local runs' mirror has neither the KNN candidates' video rows nor a
// shared verdict cache; same pattern as similar-channels.ts). Render 166
// failed silently here: getPool() hit the local mirror, every candidate
// had <3 titles, every verdict came back null.
let mainPool: pg.Pool | null = null;
function getMainPool(): pg.Pool {
  if (!mainPool) {
    const url = process.env.HB_RAILWAY_DB_URL || process.env.DATABASE_URL;
    if (!url) throw new Error('channel-b-verify: no DB url');
    mainPool = new pg.Pool({ connectionString: url, ssl: false, max: 3 });
  }
  return mainPool;
}

export interface RelationVerdict {
  format_match: 'same' | 'different';
  subject_match: 'same' | 'narrower' | 'different';
  /** Candidate's subject when it differs/narrows; the SHARED subject
   *  when subject_match='same'. 2-4 plain words ("SCP entries"). */
  subject_term: string | null;
  /** Candidate's format when format_match='different' ("quick explainer
   *  countdowns"). 2-4 words. */
  format_noun: string | null;
  confidence: 'high' | 'low';
}

/** Both axes different (or hopeless) — never show this channel. */
export function isUnrelated(v: RelationVerdict): boolean {
  return v.format_match === 'different' && v.subject_match === 'different';
}

/** Eligible for a silent saturation PAGE. The Form A montage narration
 *  claims "many channels doing this ... with the same format", so a page
 *  requires format_match='same' (subject may differ — MG's Valaritas
 *  shows a different franchise under the same-format claim). Verdicts
 *  only gate screen time; the narration stays generic. */
export function isPageWorthy(v: RelationVerdict): boolean {
  return v.format_match === 'same' && v.confidence === 'high';
}

/**
 * The narration tail matrix (MG-verbatim where attested). Returns the
 * clause completing the second_channel_opener, in both conjugations:
 *   that-form  → after "There is another channel that"
 *   ing-form   → after "And there's another channel"
 * null = same/same → caller keeps the default "same kind of videos" tail.
 */
export function relationTail(v: RelationVerdict): { that: string; ing: string } | null {
  const subj = v.subject_term?.trim();
  const fmt = v.format_noun?.trim();
  if (v.confidence === 'low') {
    // n8 hedge — vague-but-true beats specific-but-wrong.
    return { that: 'that started uploading similar content', ing: 'uploading similar content' };
  }
  if (v.format_match === 'same' && v.subject_match === 'same') return null;
  if (v.format_match === 'same' && v.subject_match === 'narrower' && subj) {
    return { that: `that makes videos only on ${subj}`, ing: `making videos only on ${subj}` };
  }
  if (v.format_match === 'same' && subj) {
    return {
      that: `that does the exact same style, just with ${subj}`,
      ing: `doing the exact same style, just with ${subj}`,
    };
  }
  if (v.format_match === 'different' && v.subject_match !== 'different' && subj && fmt) {
    return {
      that: `that covers the same ${subj}, but as ${fmt}`,
      ing: `covering the same ${subj}, but as ${fmt}`,
    };
  }
  // Missing deltas — degrade to the hedge rather than overclaim.
  return { that: 'that started uploading similar content', ing: 'uploading similar content' };
}

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

async function topTitles(channelId: string, n: number): Promise<string[]> {
  const pool = getMainPool();
  const r = await pool.query<{ title: string }>(
    `SELECT title FROM niche_spy_videos
      WHERE channel_id = $1 AND title IS NOT NULL
      ORDER BY view_count DESC NULLS LAST LIMIT $2`, [channelId, n]);
  return r.rows.map(x => x.title);
}

export interface HeroEvidence {
  channelId: string;
  nicheLabel?: string;
  /** recipe_formula_simple from NicheVars — the "what they make" line. */
  recipeFormula?: string | null;
}

/**
 * Classify candidate vs hero. Cached forever per (hero, candidate) —
 * verdicts describe catalogs, which drift slowly; a stale verdict is
 * strictly better than a per-render Gemini bill.
 */
export async function classifyRelationship(hero: HeroEvidence, candidateChannelId: string): Promise<RelationVerdict | null> {
  const pool = getMainPool();
  const hit = await pool.query<{ verdict_jsonb: RelationVerdict }>(
    `SELECT verdict_jsonb FROM content_gen_channel_relationships
      WHERE hero_channel_id = $1 AND candidate_channel_id = $2`,
    [hero.channelId, candidateChannelId]).catch(() => ({ rows: [] as Array<{ verdict_jsonb: RelationVerdict }> }));
  if (hit.rows[0]) return hit.rows[0].verdict_jsonb;

  const [heroTitles, candTitles, candName] = await Promise.all([
    topTitles(hero.channelId, 10),
    topTitles(candidateChannelId, 12),
    pool.query<{ channel_name: string | null }>(
      `SELECT channel_name FROM niche_spy_channels WHERE channel_id = $1`, [candidateChannelId],
    ).then(r => r.rows[0]?.channel_name ?? candidateChannelId),
  ]);
  if (heroTitles.length < 3 || candTitles.length < 3) {
    console.warn(`[channel-b-verify] insufficient titles for ${candidateChannelId} (hero=${heroTitles.length}, cand=${candTitles.length})`);
    return null;
  }


  const prompt = `You compare two YouTube channels for a "similar channel" callout in a faceless-niches video.

HERO channel — niche: "${hero.nicheLabel ?? 'unknown'}"; what it makes: "${hero.recipeFormula ?? 'unknown'}"
HERO top video titles:
${heroTitles.map(t => `- ${t}`).join('\n')}

CANDIDATE channel "${candName}" top video titles:
${candTitles.map(t => `- ${t}`).join('\n')}

Classify the candidate against the hero on two INDEPENDENT axes:
- format_match: "same" if the candidate uses the same VIDEO FORMAT / production style (e.g. size-comparison lineups vs ranked explainer countdowns vs scene breakdowns are all DIFFERENT formats), else "different".
- subject_match: "same" if the same subject world / topic space; "narrower" if a sub-slice of the hero's subject (one franchise, one entity type); "different" otherwise.

Also output:
- subject_term: 2-4 plain lowercase words. When subject_match is "different" or "narrower", name the CANDIDATE's subject ("SCP entries", "Game of Thrones scenes"). When "same", name the SHARED subject ("fictional monsters").
- format_noun: 2-4 plain lowercase words naming the CANDIDATE's format, ONLY when format_match is "different" ("quick explainer countdowns"); else null.
- confidence: "high" only if the titles make both axes obvious; otherwise "low".

Output ONLY JSON: {"format_match": "...", "subject_match": "...", "subject_term": "...", "format_noun": ... , "confidence": "..."}`;

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 400, thinkingConfig: { thinkingBudget: 0 } },
  });
  // PROXY first — Google keys free-tier quota per (project, caller-IP
  // region); this machine's direct route is a hard 429 (memory:
  // gemini-region-quota). 3 attempts, fresh random key + proxy each —
  // render 167 lost two candidates to one-shot 403/429s.
  let res: { ok: boolean; status: number; json(): Promise<unknown> } | null = null;
  for (let attempt = 1; attempt <= 3 && !res?.ok; attempt++) {
    const keyRow = await pool.query<{ key: string }>(
      `SELECT key FROM xgodo_api_keys
        WHERE service = 'google_ai_studio' AND status = 'active'
          AND (banned_until IS NULL OR banned_until < NOW())
        ORDER BY RANDOM() LIMIT 1`);
    const apiKey = keyRow.rows[0]?.key;
    if (!apiKey) break;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    res = null;
    try {
      const { getRandomHealthyProxy } = await import('../xgodo-proxy');
      const { fetchViaProxy } = await import('../proxy-dispatcher');
      const proxy = await getRandomHealthyProxy().catch(() => null);
      if (proxy?.url) {
        res = await fetchViaProxy(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, timeoutMs: 45_000 }, proxy.url);
      }
    } catch { /* proxy path failed */ }
    if (!res || !res.ok) {
      try {
        const rr = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(45_000) });
        res = { ok: rr.ok, status: rr.status, json: () => rr.json() };
      } catch { /* attempt failed */ }
    }
    if (!res?.ok && attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt));
  }
  if (!res || !res.ok) {
    console.warn(`[channel-b-verify] gemini HTTP ${res?.status ?? 'ERR'} for ${candidateChannelId} after 3 attempts`);
    return null;
  }
  const data = await res.json().catch(() => null) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> } | null;
  const raw = data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join('').trim() ?? '';
  let v: RelationVerdict | null = null;
  try {
    const j = JSON.parse(raw.replace(/^```(json)?/m, '').replace(/```$/m, '').trim()) as Record<string, unknown>;
    const fm = j.format_match === 'same' ? 'same' : 'different';
    const sm = j.subject_match === 'same' ? 'same' : j.subject_match === 'narrower' ? 'narrower' : 'different';
    let subj = typeof j.subject_term === 'string' ? j.subject_term.trim().toLowerCase().replace(/[."]/g, '') : null;
    let fmt = typeof j.format_noun === 'string' ? j.format_noun.trim().toLowerCase().replace(/[."]/g, '') : null;
    if (subj && (wordCount(subj) > 4 || subj.length > 40)) subj = null;
    if (fmt && (wordCount(fmt) > 4 || fmt.length > 40)) fmt = null;
    v = {
      format_match: fm,
      subject_match: sm,
      subject_term: subj,
      format_noun: fmt,
      confidence: j.confidence === 'high' ? 'high' : 'low',
    };
    // Missing required delta for the claimed relationship → low confidence.
    if (v.confidence === 'high') {
      if (v.subject_match !== 'same' && !v.subject_term) v.confidence = 'low';
      if (v.format_match === 'different' && !v.format_noun) v.confidence = 'low';
    }
  } catch {
    console.warn(`[channel-b-verify] unparseable verdict for ${candidateChannelId}: ${raw.slice(0, 120)}`);
    return null;
  }

  await pool.query(
    `INSERT INTO content_gen_channel_relationships (hero_channel_id, candidate_channel_id, verdict_jsonb)
     VALUES ($1, $2, $3)
     ON CONFLICT (hero_channel_id, candidate_channel_id) DO UPDATE SET verdict_jsonb = EXCLUDED.verdict_jsonb, updated_at = NOW()`,
    [hero.channelId, candidateChannelId, JSON.stringify(v)]).catch(() => { /* cache is best-effort */ });
  return v;
}
