/**
 * Niche Bending — fuse two proven-outlier videos from DISTINCT top-level
 * niches into one synthetic video idea (a new "bent" title + a generated
 * thumbnail).
 *
 * Source pool: the existing Outliers surface (peer_outlier_score >= 5 on
 * recently-posted videos = "verified working great, fast success"), further
 * required to carry a niche-tree L1 cluster so every candidate has a real
 * top-level niche. The `keyword` field is too coarse (only ~13 values across
 * the whole outlier pool), so the curated niche tree is the only usable niche
 * discriminator here.
 *
 * Bend step: ONE proxied direct-Gemini vision call sees both titles + both
 * source thumbnails and directly invents a new fused idea (no "explain why it
 * worked" reasoning) → {bent_title, thumbnail_prompt}. Then one image-gen job
 * (nanobanana2, dispatch:'any') renders the synthetic thumbnail, conditioned on
 * BOTH source thumbnails passed as comma-separated imageURI refs.
 *
 * Reuses: the outliers ranking, getActiveTreeClusterIds() scoping, the
 * proxied-Gemini pattern (pickHealthyAiKey + getRandomHealthyProxy +
 * fetchViaProxy — PapaiAPI drops images so vision MUST be direct+proxied),
 * and submitImageGenBatch({dispatchAny:true}).
 */
import { getPool } from './db';
import { getActiveTreeClusterIds } from './niche-search';
import { getRandomHealthyProxy } from './xgodo-proxy';
import { fetchViaProxy, type ProxyFetchResponse } from './proxy-dispatcher';
import { submitImageGenBatch, tickImageGen } from './xgodo-imagegen';

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const PROXY_ATTEMPTS = 6;
const PER_ATTEMPT_TIMEOUT_MS = 30_000;
const BEND_MODEL = 'nanobanana2';   // greater limits; free passthrough to xgodo

export interface BendCandidate {
  id: number;
  url: string;
  title: string;
  thumbnail: string;
  viewCount: number;
  channelName: string;
  subscriberCount: number | null;
  peerOutlierScore: number | null;
  postedAt: string | null;
  isShort: boolean;
  shortFlag: boolean | null;  // cached is_short from DB (null = not yet detected)
  nicheLabel: string;   // effective (L2 if present, else L1) label — for display
  l1Id: number;         // top-level cluster id — the distinct-niche key
  l1Label: string;      // top-level label
}

/** AI-key pooling (mirrors lib/embed-direct.ts). */
interface AiKeyRow { id: number; key: string; }
async function pickHealthyAiKey(): Promise<AiKeyRow | null> {
  const pool = await getPool();
  const r = await pool.query<AiKeyRow>(
    `SELECT id, key FROM xgodo_api_keys
      WHERE service = 'google_ai_studio' AND status = 'active'
        AND (banned_until IS NULL OR banned_until < NOW())
      ORDER BY RANDOM() LIMIT 1`,
  );
  return r.rows[0] ?? null;
}
function invalidateKey(keyId: number, reason: string): void {
  void (async () => {
    try {
      const pool = await getPool();
      await pool.query(
        `UPDATE xgodo_api_keys SET status='invalid', invalidated_at=NOW() WHERE id=$1 AND status='active'`,
        [keyId],
      );
      console.log(`[niche-bend] invalidated key id=${keyId} (${reason})`);
    } catch { /* fire-and-forget */ }
  })();
}
function cooloffKey(keyId: number, seconds = 90): void {
  void (async () => {
    try {
      const pool = await getPool();
      await pool.query(
        `UPDATE xgodo_api_keys SET banned_until = NOW() + ($1 || ' seconds')::interval WHERE id=$2`,
        [seconds, keyId],
      );
    } catch { /* fire-and-forget */ }
  })();
}

/**
 * Pull top outlier videos that carry an active-tree L1 niche. One row per
 * channel (the channel's best video), ranked by peer_outlier_score * (implied
 * via the base ordering) — we keep the outliers surface's ordering: score DESC
 * then views DESC.
 */
export async function getBendCandidates(opts: {
  limit?: number;
  minOutlier?: number;
  minViews?: number | null;
  postedWithinDays?: number | null;
  type?: 'long' | 'short' | '';
  randomize?: boolean;
} = {}): Promise<BendCandidate[]> {
  const pool = await getPool();
  const clusterIds = await getActiveTreeClusterIds();
  if (!clusterIds.length) return [];

  const limit = Math.min(opts.limit ?? 120, 400);
  const minOutlier = opts.minOutlier ?? 5;
  const minViews = opts.minViews ?? null;
  const postedWithinDays = opts.postedWithinDays ?? 240;
  const type = opts.type ?? '';

  const params: (number | number[])[] = [clusterIds];
  let p = 2;
  const conds: string[] = [
    `c.peer_outlier_score IS NOT NULL`,
    `c.peer_outlier_score >= $${p++}`,
    `v.thumbnail IS NOT NULL`,
    `v.is_short IS NOT TRUE`,   // exclude detected Shorts (URL type-filter is inert: all youtu.be/ID)
  ];
  params.push(minOutlier);
  if (minViews != null) { conds.push(`v.view_count >= $${p++}`); params.push(minViews); }
  if (postedWithinDays != null) { conds.push(`v.posted_at >= NOW() - ($${p++} || ' days')::interval`); params.push(postedWithinDays); }
  if (type === 'short') conds.push(`v.url ILIKE '%/shorts/%'`);
  else if (type === 'long') conds.push(`v.url NOT ILIKE '%/shorts/%'`);

  const limitP = p++;
  params.push(limit);

  // For each candidate video, resolve its most-specific active-tree cluster,
  // then walk up to the L1 (parent_cluster_id IS NULL). label uses the curated
  // COALESCE(label, ai_label, auto_label).
  const sql = `
    WITH active AS (
      SELECT id, parent_cluster_id,
             COALESCE(label, ai_label, auto_label) AS lbl
      FROM niche_tree_clusters
      WHERE id = ANY($1::int[])
    ),
    ranked AS (
      SELECT DISTINCT ON (c.channel_id)
        v.id, v.url, v.title, v.thumbnail, v.view_count, v.channel_name,
        v.posted_at, v.channel_id, v.is_short,
        c.subscriber_count, c.peer_outlier_score
      FROM niche_spy_videos v
      JOIN niche_spy_channels c ON c.channel_id = v.channel_id
      WHERE ${conds.join(' AND ')}
        AND EXISTS (
          SELECT 1 FROM niche_tree_assignments a
          JOIN active ac ON ac.id = a.cluster_id
          WHERE a.video_id = v.id
        )
      ORDER BY c.channel_id, v.view_count DESC NULLS LAST
    ),
    tagged AS (
      SELECT r.*,
             asg.cluster_id AS cid, ac.parent_cluster_id AS parent_id, ac.lbl AS niche_label
      FROM ranked r
      JOIN LATERAL (
        SELECT a.cluster_id
        FROM niche_tree_assignments a
        JOIN active ax ON ax.id = a.cluster_id
        WHERE a.video_id = r.id
        -- prefer the most specific (a child cluster has a parent) assignment
        ORDER BY (ax.parent_cluster_id IS NOT NULL) DESC, a.cluster_id
        LIMIT 1
      ) asg ON TRUE
      JOIN active ac ON ac.id = asg.cluster_id
    )
    SELECT t.*,
           COALESCE(t.parent_id, t.cid) AS l1_id,
           COALESCE(l1.lbl, t.niche_label) AS l1_label
    FROM tagged t
    LEFT JOIN active l1 ON l1.id = t.parent_id
    ORDER BY ${opts.randomize ? 'RANDOM()' : 't.peer_outlier_score DESC NULLS LAST, t.view_count DESC NULLS LAST'}
    LIMIT $${limitP}`;

  const r = await pool.query(sql, params);
  return r.rows.map(rowToCand);
}

function rowToCand(row: Record<string, unknown>): BendCandidate {
  const url = row.url as string;
  return {
    id: row.id as number,
    url,
    title: row.title as string,
    thumbnail: row.thumbnail as string,
    viewCount: parseInt(String(row.view_count)) || 0,
    channelName: row.channel_name as string,
    subscriberCount: row.subscriber_count != null ? parseInt(String(row.subscriber_count)) : null,
    peerOutlierScore: row.peer_outlier_score != null ? parseFloat(String(row.peer_outlier_score)) : null,
    postedAt: row.posted_at as string,
    isShort: typeof url === 'string' && url.includes('/shorts/'),
    shortFlag: row.is_short == null ? null : Boolean(row.is_short),
    nicheLabel: (row.niche_label as string) || (row.l1_label as string) || 'niche',
    l1Id: row.l1_id as number,
    l1Label: (row.l1_label as string) || (row.niche_label as string) || 'niche',
  };
}

/**
 * Resolve SPECIFIC video ids to bend candidates (for the on-demand "make your
 * own" path and synthesize validation) — the specific videos themselves, not a
 * channel's top-by-view (so no DISTINCT ON), still requiring a live thumbnail +
 * an active-tree cluster so every result carries a valid L1 niche.
 */
export async function getBendCandidatesByIds(ids: number[]): Promise<BendCandidate[]> {
  if (!ids.length) return [];
  const pool = await getPool();
  const clusterIds = await getActiveTreeClusterIds();
  if (!clusterIds.length) return [];
  const sql = `
    WITH active AS (
      SELECT id, parent_cluster_id, COALESCE(label, ai_label, auto_label) AS lbl
      FROM niche_tree_clusters WHERE id = ANY($1::int[])
    ),
    base AS (
      SELECT v.id, v.url, v.title, v.thumbnail, v.view_count, v.channel_name,
             v.posted_at, v.channel_id, v.is_short, c.subscriber_count, c.peer_outlier_score
      FROM niche_spy_videos v
      JOIN niche_spy_channels c ON c.channel_id = v.channel_id
      WHERE v.id = ANY($2::int[]) AND v.thumbnail IS NOT NULL
        AND v.is_short IS NOT TRUE
        AND EXISTS (SELECT 1 FROM niche_tree_assignments a JOIN active ac ON ac.id=a.cluster_id WHERE a.video_id=v.id)
    ),
    tagged AS (
      SELECT b.*, asg.cluster_id AS cid, ac.parent_cluster_id AS parent_id, ac.lbl AS niche_label
      FROM base b
      JOIN LATERAL (
        SELECT a.cluster_id FROM niche_tree_assignments a JOIN active ax ON ax.id=a.cluster_id
        WHERE a.video_id=b.id ORDER BY (ax.parent_cluster_id IS NOT NULL) DESC, a.cluster_id LIMIT 1
      ) asg ON TRUE
      JOIN active ac ON ac.id = asg.cluster_id
    )
    SELECT t.*, COALESCE(t.parent_id, t.cid) AS l1_id, COALESCE(l1.lbl, t.niche_label) AS l1_label
    FROM tagged t LEFT JOIN active l1 ON l1.id = t.parent_id`;
  const r = await pool.query(sql, [clusterIds, ids]);
  return r.rows.map(rowToCand);
}

/** Download an image URL to base64 (for inlineData). Returns null on failure. */
async function fetchThumbBase64(url: string): Promise<{ mime: string; data: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return null;
    const mime = res.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 500) return null;
    return { mime: mime.startsWith('image/') ? mime : 'image/jpeg', data: buf.toString('base64') };
  } catch { return null; }
}

function stripJsonFences(t: string): string {
  return t.replace(/^\s*```json?/im, '').replace(/```\s*$/m, '').trim();
}

/**
 * ONE proxied direct-Gemini call: sees both titles + both thumbnails and
 * invents a fused idea. Returns {bentTitle, thumbnailPrompt} or null.
 */
async function bendWithGemini(a: BendCandidate, b: BendCandidate): Promise<{ bentTitle: string; thumbnailPrompt: string } | null> {
  const [ta, tb] = await Promise.all([fetchThumbBase64(a.thumbnail), fetchThumbBase64(b.thumbnail)]);

  const promptText =
`You are a viral YouTube ideation engine. Below are TWO proven high-performing videos from two DIFFERENT niches, each with its title and its thumbnail image (in order: A then B).

VIDEO A — niche "${a.l1Label}": "${a.title}"
VIDEO B — niche "${b.l1Label}": "${b.title}"

Invent ONE brand-new, unique video idea that BENDS these two together — a fresh concept that fuses the hook/format of A with the hook/format of B into something that feels novel and clickable, belonging to neither niche exactly but born from both. Do not merely combine the words; create a genuinely new idea.

Return ONLY minified JSON, no prose:
{"bent_title":"<a punchy YouTube title for the new idea, <= 80 chars>","thumbnail_prompt":"<a vivid image-generation prompt describing the thumbnail for this new idea — subject, composition, mood, colors, on-screen text if any — fusing the visual language of BOTH source thumbnails, <= 400 chars>"}`;

  const parts: Array<Record<string, unknown>> = [{ text: promptText }];
  if (ta) parts.push({ inlineData: { mimeType: ta.mime, data: ta.data } });
  if (tb) parts.push({ inlineData: { mimeType: tb.mime, data: tb.data } });

  const body = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { temperature: 0.95, responseMimeType: 'application/json' },
  });

  for (let attempt = 0; attempt < PROXY_ATTEMPTS; attempt++) {
    const keyRow = await pickHealthyAiKey();
    if (!keyRow) return null;
    const proxy = await getRandomHealthyProxy();
    if (!proxy) continue;

    let res: ProxyFetchResponse;
    try {
      res = await fetchViaProxy(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keyRow.key },
        body,
        timeoutMs: PER_ATTEMPT_TIMEOUT_MS,
      }, proxy.url);
    } catch { continue; }   // dead proxy → rotate

    let txt: string;
    try { txt = await res.text(); } catch { continue; }

    if (res.status === 429) { cooloffKey(keyRow.id, 90); continue; }
    if (res.status === 401 || res.status === 403) { invalidateKey(keyRow.id, `gemini_${res.status}`); continue; }
    if (!res.ok) { continue; }

    try {
      const d = JSON.parse(txt);
      const out = d?.candidates?.[0]?.content?.parts?.map((x: { text?: string }) => x.text || '').join('') || '';
      const v = JSON.parse(stripJsonFences(out));
      if (typeof v.bent_title === 'string' && typeof v.thumbnail_prompt === 'string' && v.bent_title.trim() && v.thumbnail_prompt.trim()) {
        return { bentTitle: v.bent_title.trim().slice(0, 200), thumbnailPrompt: v.thumbnail_prompt.trim().slice(0, 900) };
      }
    } catch { /* parse fail → rotate */ }
  }
  return null;
}

/**
 * Full bend: validate distinct L1, synthesize title+thumbnail prompt, submit
 * the image-gen job, persist a niche_bends row. Returns the new bend id.
 */
/** On-demand path: resolve two video ids to candidates, then bend them. */
export async function synthesizeBendByIds(videoAId: number, videoBId: number): Promise<
  { ok: true; id: number } | { ok: false; error: string }
> {
  const cands = await getBendCandidatesByIds([videoAId, videoBId]);
  const a = cands.find(c => c.id === videoAId);
  const b = cands.find(c => c.id === videoBId);
  if (!a || !b) return { ok: false, error: 'both videos must be current bend candidates' };
  return synthesizeBend(a, b);
}

export async function synthesizeBend(a: BendCandidate, b: BendCandidate): Promise<
  { ok: true; id: number } | { ok: false; error: string }
> {
  const pool = await getPool();
  if (a.id === b.id) return { ok: false, error: 'pick two different videos' };
  if (a.l1Id === b.l1Id) return { ok: false, error: 'pick two videos from DIFFERENT top-level niches' };

  const bent = await bendWithGemini(a, b);
  if (!bent) return { ok: false, error: 'idea synthesis failed (no vision result)' };

  // Insert the row first so we can tag the image-gen job with its id.
  const ins = await pool.query<{ id: number }>(
    `INSERT INTO niche_bends
       (video_a_id, video_b_id, title_a, title_b, thumb_a, thumb_b,
        niche_a_label, niche_b_label, l1_a_id, l1_b_id, bent_title, thumbnail_prompt, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'rendering') RETURNING id`,
    [a.id, b.id, a.title, b.title, a.thumbnail, b.thumbnail,
     a.nicheLabel, b.nicheLabel, a.l1Id, b.l1Id, bent.bentTitle, bent.thumbnailPrompt],
  );
  const bendId = ins.rows[0].id;
  await renderThumbnail(bendId, bent.thumbnailPrompt, a.thumbnail);
  return { ok: true, id: bendId };
}

/**
 * Submit (or re-submit) the synthetic thumbnail render for a bend.
 * SINGLE ref (thumbnail A) — measured: nanobanana2 with 2 comma-separated refs
 * fails ~60% ("Time limit exceeded"), 1 ref ~80%. The fusion of both niches
 * already lives in the Gemini-authored thumbnail_prompt, so B's look survives
 * in text. Bumps render_attempts; caller retries failures.
 */
async function renderThumbnail(bendId: number, prompt: string, thumbA: string): Promise<void> {
  const pool = await getPool();
  const sub = await submitImageGenBatch(
    [{ prompt, aspect: '16:9', model: BEND_MODEL, imageURI: thumbA, purpose: `niche_bend:${bendId}` }],
    { dispatchAny: true },
  );
  if (sub.submitted && sub.ids.length) {
    await pool.query(
      `UPDATE niche_bends SET imagegen_task_id=$1, status='rendering', error=NULL,
         render_attempts=render_attempts+1, updated_at=NOW() WHERE id=$2`,
      [sub.ids[0], bendId],
    );
  } else {
    await pool.query(
      `UPDATE niche_bends SET status='error', error=$1, render_attempts=render_attempts+1, updated_at=NOW() WHERE id=$2`,
      [(sub.errors[0] || 'imagegen submit failed').slice(0, 300), bendId],
    );
  }
}

const MAX_RENDER_ATTEMPTS = 4;

/**
 * Background baker tick (called from instrumentation runAll, gated by
 * admin_config.niche_bend_baker_enabled). Mints fresh bends CONTINUOUSLY —
 * up to `perTick` new ideas each tick — exploring the whole outlier pool via
 * randomized pair sampling, so it keeps generating indefinitely rather than
 * stopping at a fixed buffer. Bounded only by:
 *   - `target`: a high storage ceiling (max stored, non-destructive safety valve);
 *   - `maxInFlight`: caps concurrent renders so the SHARED imagegen worker pool
 *     is never starved for other rofe operations;
 *   - fresh-pair availability (distinct-L1, unused in the last 30 days).
 */
export async function runBendBakerTick(
  opts: { target?: number; perTick?: number; maxInFlight?: number } = {},
): Promise<{ baked: number; retried: number; ready: number; rendering: number; skipped?: string }> {
  const pool = await getPool();
  const target = opts.target ?? 5000;        // storage ceiling (raisable)
  const perTick = Math.max(1, opts.perTick ?? 3);
  const maxInFlight = Math.max(1, opts.maxInFlight ?? 10);

  // 0. Run the shared imagegen tick so baked thumbnails download to the volume
  //    even when nobody has the admin Image Gen page open. Reuses the exact
  //    existing pipeline (xgodo workers + imagegen_tasks) — no parallel system.
  await tickImageGen().catch(() => {});

  // 0b. Persist rendering->done for any bend whose thumbnail is now downloaded.
  //     listBends only *displays* downloaded-as-done (a read); without this the
  //     DB status stayed 'rendering' forever, inflating the in-flight count and
  //     tripping the `rendering < N` guard below so baking self-blocked.
  await pool.query(
    `UPDATE niche_bends b SET status='done', updated_at=NOW()
       FROM imagegen_tasks t
      WHERE t.id = b.imagegen_task_id AND b.status='rendering' AND t.local_path IS NOT NULL`,
  ).catch(() => {});

  // 0c. Self-heal: drop any bend whose parent is (now) confirmed a Short. The
  //     inline pick-time check is bounded + fail-open, so a Short can slip
  //     through; once its is_short flag lands, remove the bend from the feed.
  await pool.query(
    `DELETE FROM niche_bends b
      WHERE EXISTS (SELECT 1 FROM niche_spy_videos v
                     WHERE v.id IN (b.video_a_id, b.video_b_id) AND v.is_short = true)`,
  ).catch(() => {});

  // 1. Retry timed-out thumbnails (reuse the title+prompt — no new Gemini call).
  //    One retry per tick keeps the imagegen tick from being drowned.
  let retried = 0;
  const stuck = await pool.query<{ id: number; thumbnail_prompt: string; thumb_a: string }>(
    `SELECT b.id, b.thumbnail_prompt, b.thumb_a
       FROM niche_bends b JOIN imagegen_tasks t ON t.id = b.imagegen_task_id
      WHERE b.status='rendering' AND t.status='failed' AND b.render_attempts < $1
      ORDER BY b.updated_at ASC LIMIT 1`,
    [MAX_RENDER_ATTEMPTS],
  );
  if (stuck.rows.length) {
    await renderThumbnail(stuck.rows[0].id, stuck.rows[0].thumbnail_prompt, stuck.rows[0].thumb_a);
    retried = 1;
  }
  // give up on renders that exhausted their attempts
  await pool.query(
    `UPDATE niche_bends b SET status='error', error='thumbnail render failed after retries', updated_at=NOW()
       FROM imagegen_tasks t
      WHERE t.id=b.imagegen_task_id AND b.status='rendering' AND t.status='failed' AND b.render_attempts >= $1`,
    [MAX_RENDER_ATTEMPTS],
  );

  // 2. Buffer level = fresh bends that are ready-or-rendering (not errored).
  const cnt = await pool.query<{ ready: string; rendering: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE status='done') AS ready,
       COUNT(*) FILTER (WHERE status='rendering') AS rendering
     FROM niche_bends WHERE created_at > NOW() - INTERVAL '30 days'`,
  );
  const ready = parseInt(cnt.rows[0].ready) || 0;
  const rendering = parseInt(cnt.rows[0].rendering) || 0;

  // 3. Continuous baking: mint up to `perTick` fresh bends this tick while under
  //    the storage ceiling and not saturating the shared imagegen workers. Each
  //    pickFreshPair sees the bends we just inserted (dedup), so no repeats.
  let baked = 0;
  let inFlight = rendering;
  for (let i = 0; i < perTick; i++) {
    if (ready + inFlight + baked >= target) break;   // storage safety valve
    if (inFlight >= maxInFlight) break;              // protect shared imagegen pool
    const pair = await pickFreshPair();
    if (!pair) break;                                // no fresh distinct-L1 pair right now
    const res = await synthesizeBend(pair.a, pair.b);
    if (!res.ok) break;                              // synth failed — stop this tick
    baked++; inFlight++;
  }
  return { baked, retried, ready, rendering };
}

/**
 * Pick a distinct-L1 pair not baked in the last 30 days. Rotates the "A" anchor
 * across the top candidates so successive bakes aren't all the same top video.
 */
// The candidate query (DISTINCT ON over ~1.8M niche_spy_videos + LATERAL niche
// joins) costs ~13s, far too slow to run per-bake. Cache a randomized 400-sample
// in-process; refresh every few minutes so continuous baking stays fast AND still
// explores a NEW slice of the whole outlier pool on each refresh.
let candCache: { list: BendCandidate[]; at: number } | null = null;
const CAND_TTL_MS = 5 * 60 * 1000;
async function getCachedCandidates(): Promise<BendCandidate[]> {
  if (candCache && Date.now() - candCache.at < CAND_TTL_MS && candCache.list.length >= 2) return candCache.list;
  // type:'long' — Shorts make weak, low-context parents for bending.
  const list = await getBendCandidates({ limit: 400, randomize: true, type: 'long' });
  candCache = { list, at: Date.now() };
  return list;
}

// Shorts detection: the dataset stores every video as youtu.be/ID with no
// duration, so there's no stored short signal. youtube.com/shorts/{ID} returns
// 200 for a real Short but 3xx (redirect to /watch) for long-form — use that,
// cache the result on niche_spy_videos.is_short. Fail-open (unknown -> treat as
// long) so a flaky check never blocks baking.
function ytIdOf(url: string): string | null {
  const m = url.match(/(?:youtu\.be\/|\/shorts\/|v=)([\w-]{11})/);
  return m ? m[1] : null;
}
async function detectShort(url: string): Promise<boolean | null> {
  const id = ytIdOf(url);
  if (!id) return null;
  try {
    const r = await fetch(`https://www.youtube.com/shorts/${id}`, {
      redirect: 'manual', signal: AbortSignal.timeout(8000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    return r.status === 200;   // 200 = Short; 3xx = redirect to /watch = long
  } catch { return null; }
}
// True if the candidate is a Short. Uses the cached flag; detects+persists when
// unknown. Fail-open: an undetermined check counts as long (returns false).
async function resolveShort(c: BendCandidate): Promise<boolean> {
  if (c.shortFlag != null) return c.shortFlag;
  const short = await detectShort(c.url);
  if (short != null) {
    c.shortFlag = short;
    const pool = await getPool();
    await pool.query(`UPDATE niche_spy_videos SET is_short=$1 WHERE id=$2`, [short, c.id]).catch(() => {});
  }
  return short === true;
}

async function pickFreshPair(): Promise<{ a: BendCandidate; b: BendCandidate } | null> {
  const pool = await getPool();
  const cands = await getCachedCandidates();
  if (cands.length < 2) return null;
  const usedR = await pool.query<{ video_a_id: number; video_b_id: number }>(
    `SELECT video_a_id, video_b_id FROM niche_bends WHERE created_at > NOW() - INTERVAL '30 days'`,
  );
  const usedPair = new Set(usedR.rows.map(r => `${r.video_a_id}:${r.video_b_id}`));
  const usedVid = new Set<number>();
  for (const r of usedR.rows) { usedVid.add(r.video_a_id); usedVid.add(r.video_b_id); }

  // Prefer an A that hasn't been used yet; else fall back to the top.
  const aPool = cands.filter(c => !usedVid.has(c.id));
  const aList = aPool.length ? aPool : cands;
  let checks = 0;                       // bound inline Shorts checks per call
  for (const a of aList) {
    if (checks < 12 && await resolveShort(a)) { checks++; continue; }  // skip a Short A
    const cand = cands.find(c => c.l1Id !== a.l1Id && c.id !== a.id
      && !usedPair.has(`${a.id}:${c.id}`) && !usedPair.has(`${c.id}:${a.id}`)
      && (!usedVid.has(c.id) || aPool.length === 0));
    if (!cand) continue;
    if (checks < 12 && await resolveShort(cand)) { checks++; continue; }  // skip a Short B
    return { a, b: cand };
  }
  return null;
}

/**
 * The feed: recent baked bends (ready first, then still-rendering). ONE query —
 * all feed data (title + parent snapshots) lives on niche_bends, so no niche_spy
 * joins. The rich parent details are fetched only on click via getBend.
 */
export async function listBends(limit = 60, beforeId?: number): Promise<BendRow[]> {
  const pool = await getPool();
  // id-cursor pagination (id is monotonic with time): newest-first, load older
  // pages via beforeId. Stable even as new ideas bake at the top — no offset
  // drift, no dup/skip on infinite scroll.
  const params: number[] = [Math.min(limit, 200)];
  let cursor = '';
  if (beforeId && Number.isFinite(beforeId)) { params.push(beforeId); cursor = `AND b.id < $2`; }
  const r = await pool.query(
    `SELECT b.id, b.bent_title, b.thumbnail_prompt, b.status, b.error, b.imagegen_task_id,
            b.title_a, b.thumb_a, b.niche_a_label, b.title_b, b.thumb_b, b.niche_b_label,
            (t.local_path IS NOT NULL) AS downloaded
       FROM niche_bends b
       LEFT JOIN imagegen_tasks t ON t.id = b.imagegen_task_id
      WHERE b.status IN ('done','rendering') ${cursor}
      ORDER BY b.id DESC
      LIMIT $1`,
    params,
  );
  return r.rows.map(row => ({
    id: row.id,
    bentTitle: row.bent_title,
    thumbnailPrompt: row.thumbnail_prompt,
    status: row.downloaded && row.status === 'rendering' ? 'done' : row.status,
    error: row.error,
    thumbnailUrl: row.downloaded ? `/api/niche-bend/thumb/${row.imagegen_task_id}` : null,
    parents: {
      a: { title: row.title_a, thumb: row.thumb_a, niche: row.niche_a_label },
      b: { title: row.title_b, thumb: row.thumb_b, niche: row.niche_b_label },
    },
  }));
}

/** Auto-pick: top candidate + first below it in a DIFFERENT L1 niche. */
export function autoPickPair(cands: BendCandidate[]): { a: BendCandidate; b: BendCandidate } | null {
  if (cands.length < 2) return null;
  const a = cands[0];
  const b = cands.find(c => c.l1Id !== a.l1Id);
  if (!b) return null;
  return { a, b };
}

/** Light parent shape used in the feed. */
interface FeedParent { title: string; thumb: string; niche: string }
export interface BendRow {
  id: number;
  bentTitle: string | null;
  thumbnailPrompt: string | null;
  status: string;
  error: string | null;
  thumbnailUrl: string | null;   // final synthetic thumbnail once downloaded
  parents: { a: FeedParent; b: FeedParent };
}

/** Rich parent shape for the detail modal — joined back to the live video/channel. */
export interface ParentVideo {
  videoId: number;
  url: string | null;
  title: string;
  thumb: string;
  niche: string;
  viewCount: number | null;
  channelName: string | null;
  subscriberCount: number | null;
  peerOutlierScore: number | null;
}
export interface BendDetail extends Omit<BendRow, 'parents'> {
  parents: { a: ParentVideo; b: ParentVideo };
}

/**
 * Detail read (for the modal): one query joins both parent videos + channels
 * so each parent card can show views/channel/outlier + a YouTube link. Falls
 * back to the snapshot stored on the bend if a source video was since deleted.
 */
export async function getBend(id: number): Promise<BendDetail | null> {
  const pool = await getPool();
  const r = await pool.query(
    `SELECT b.*,
       (t.local_path IS NOT NULL) AS downloaded,
       va.url a_url, COALESCE(va.title, b.title_a) a_title, COALESCE(va.thumbnail, b.thumb_a) a_thumb,
       va.view_count a_views, va.channel_name a_channel, ca.subscriber_count a_subs, ca.peer_outlier_score a_score,
       vb.url b_url, COALESCE(vb.title, b.title_b) b_title, COALESCE(vb.thumbnail, b.thumb_b) b_thumb,
       vb.view_count b_views, vb.channel_name b_channel, cb.subscriber_count b_subs, cb.peer_outlier_score b_score
     FROM niche_bends b
     LEFT JOIN imagegen_tasks t   ON t.id = b.imagegen_task_id
     LEFT JOIN niche_spy_videos va ON va.id = b.video_a_id
     LEFT JOIN niche_spy_channels ca ON ca.channel_id = va.channel_id
     LEFT JOIN niche_spy_videos vb ON vb.id = b.video_b_id
     LEFT JOIN niche_spy_channels cb ON cb.channel_id = vb.channel_id
     WHERE b.id = $1`,
    [id],
  );
  if (!r.rows.length) return null;
  const row = r.rows[0];

  let thumbnailUrl: string | null = null;
  let status: string = row.status;
  if (row.imagegen_task_id && row.downloaded) {
    thumbnailUrl = `/api/niche-bend/thumb/${row.imagegen_task_id}`;
    if (status === 'rendering') {
      status = 'done';
      pool.query(`UPDATE niche_bends SET status='done', updated_at=NOW() WHERE id=$1`, [id]).catch(() => {});
    }
  }
  const num = (v: unknown): number | null => (v == null ? null : Number(v));
  return {
    id: row.id,
    bentTitle: row.bent_title,
    thumbnailPrompt: row.thumbnail_prompt,
    status,
    error: row.error,
    thumbnailUrl,
    parents: {
      a: { videoId: row.video_a_id, url: row.a_url, title: row.a_title, thumb: row.a_thumb, niche: row.niche_a_label,
           viewCount: num(row.a_views), channelName: row.a_channel, subscriberCount: num(row.a_subs), peerOutlierScore: num(row.a_score) },
      b: { videoId: row.video_b_id, url: row.b_url, title: row.b_title, thumb: row.b_thumb, niche: row.niche_b_label,
           viewCount: num(row.b_views), channelName: row.b_channel, subscriberCount: num(row.b_subs), peerOutlierScore: num(row.b_score) },
    },
  };
}
