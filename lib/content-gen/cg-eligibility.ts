/**
 * Single source of truth for "is this channel content-gen eligible" — the KPI
 * the YT-niche-spy flywheel exists to produce: channels that pass the hard
 * discovery rules AND survive the English gate.
 *
 * The gate set MIRRORS lib/content-gen/discovery.ts `discoverChannels()` (the
 * live draft-pool query). To prevent drift:
 *   - the two JS English gates are REUSED, not re-implemented — `isNonEnglishChannel`
 *     (discovery.ts, the script/label gate #13) and `filterEnglishCandidates`
 *     (english-gate.ts, the heuristic+franc gate #14 the drafts route applies);
 *   - the SQL gates are copied here and guarded by
 *     scripts/local/cg-eligibility-parity.mts, which asserts this predicate
 *     agrees with `discoverChannels` on live data.
 * Bump CG_EVAL_VERSION when the gate logic changes → the sweep re-stamps.
 *
 * NOTE: the topK/LIMIT 500 and the live thumbnail HEAD re-check in
 * discoverChannels are a pool-size cap + transient liveness check, NOT
 * eligibility — deliberately excluded here. The shorts-focus gate is a
 * pool-time live YT probe on ~60 candidates, also excluded (matches the KPI
 * definition: "hard discovery rules + English gate").
 */
import { getPool } from '@/lib/db';
import { isNonEnglishChannel } from './discovery';
import { filterEnglishCandidates } from './english-gate';

/** Bump when any gate below changes so the sweep re-evaluates stamped rows. */
export const CG_EVAL_VERSION = 1;

export type CgFailReason =
  | 'not_enriched'      // subscriber_count IS NULL (enricher hasn't reached it)
  | 'subs_band'         // subs not in [10k, 5M]
  | 'used_channel'      // already in content_gen_used_channels
  | 'lang_analysis'     // channel_analysis / cga says non-English
  | 'topview_zero'      // top video has 0 views
  | 'view_sub_ratio'    // top_view / subs < 5
  | 'view_floor'        // top_view below age-tiered floor
  | 'age'               // channel older than 730d
  | 'recency'           // top video older than 12 months
  | 'min_videos'        // < 5 videos indexed
  | 'median_ratio'      // median/top view ratio < 0.05 (one-hit wonder)
  | 'english_script'    // discovery.ts non-Latin / foreign-label gate
  | 'english_gate';     // english-gate.ts heuristic + franc gate

export interface CgEval {
  channel_id: string;
  eligible: boolean;
  fail_reasons: CgFailReason[];
  subscriber_count: number | null;
  channel_name: string | null;
  channel_handle: string | null;
  channel_avatar: string | null;
  top_video_id: number | null;
  top_video_title: string | null;
  top_video_url: string | null;
  top_video_views: number | null;
  channel_age_days: number | null;
}

interface GateRow {
  channel_id: string;
  channel_name: string | null;
  channel_handle: string | null;
  channel_avatar: string | null;
  subscriber_count: string | null;
  top_video_id: number | null;
  top_video_title: string | null;
  top_video_url: string | null;
  top_video_views: string | null;
  channel_age_days: string | null;
  g_enriched: boolean;
  g_subs_band: boolean;
  g_not_used: boolean;
  g_lang_analysis: boolean;
  g_topview_pos: boolean;
  g_view_sub_ratio: boolean;
  g_view_floor: boolean;
  g_age: boolean;
  g_recency: boolean;
  g_min_videos: boolean;
  g_median_ratio: boolean;
}

/**
 * Evaluate CG-eligibility for a set of channels (or all enriched channels if
 * `channelIds` is omitted — heavy, used only by the parity test). Returns one
 * CgEval per channel that has at least one indexed video. Channels never seen
 * in niche_spy_videos are simply absent from the result.
 */
export async function evaluateChannelEligibility(
  channelIds?: string[],
): Promise<CgEval[]> {
  const pool = await getPool();
  const scoped = Array.isArray(channelIds);
  if (scoped && channelIds!.length === 0) return [];
  const params: unknown[] = scoped ? [channelIds] : [];
  const chFilter = scoped ? `AND v.channel_id = ANY($1::text[])` : '';

  // Mirror of discoverChannels PASS-1, but each gate is a boolean column
  // (not a WHERE filter) so we can report WHICH gate killed a channel — the
  // funnel + gate-killer breakdown depend on it. age_days lives in its own
  // CTE layer because a SELECT can't reference a sibling output alias.
  const sql = `
    WITH per_channel AS (
      SELECT v.channel_id,
        COUNT(*)::int AS videos_indexed,
        MAX(v.view_count) AS top_video_views,
        (PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY v.view_count))::bigint AS median_video_views,
        MIN(v.channel_created_at) AS channel_created_at_v,
        MIN(v.posted_at) AS earliest_video_posted_at
      FROM niche_spy_videos v
      WHERE v.channel_id IS NOT NULL AND v.view_count IS NOT NULL AND v.thumbnail_dead_at IS NULL
        ${chFilter}
      GROUP BY v.channel_id
    ),
    top_video AS (
      SELECT DISTINCT ON (v.channel_id)
        v.channel_id, v.id AS top_video_id, v.title AS top_video_title,
        v.thumbnail AS top_video_thumbnail, v.url AS top_video_url,
        v.posted_at AS top_video_posted_at
      FROM niche_spy_videos v
      WHERE v.channel_id IS NOT NULL AND v.view_count IS NOT NULL AND v.thumbnail_dead_at IS NULL
        ${chFilter}
      ORDER BY v.channel_id, v.view_count DESC NULLS LAST
    ),
    enriched AS (
      SELECT pc.channel_id, sc.channel_name, sc.channel_handle, sc.channel_avatar,
        sc.subscriber_count,
        COALESCE(sc.channel_created_at, sc.first_upload_at, pc.channel_created_at_v, pc.earliest_video_posted_at) AS effective_created_at,
        pc.videos_indexed, pc.top_video_views, pc.median_video_views,
        tv.top_video_id, tv.top_video_title, tv.top_video_url, tv.top_video_posted_at
      FROM per_channel pc
      JOIN niche_spy_channels sc ON sc.channel_id = pc.channel_id
      JOIN top_video tv ON tv.channel_id = pc.channel_id
    ),
    gated AS (
      SELECT *, EXTRACT(EPOCH FROM (NOW() - effective_created_at)) / 86400 AS age_days
      FROM enriched
    )
    SELECT
      channel_id, channel_name, channel_handle, channel_avatar,
      subscriber_count, top_video_id, top_video_title, top_video_url,
      top_video_views, age_days AS channel_age_days,
      (subscriber_count IS NOT NULL) AS g_enriched,
      (subscriber_count BETWEEN 10000 AND 5000000) AS g_subs_band,
      (channel_id NOT IN (SELECT channel_id FROM content_gen_used_channels)) AS g_not_used,
      (NOT EXISTS (SELECT 1 FROM channel_analysis ca WHERE ca.channel_id = gated.channel_id AND ca.language IS NOT NULL AND ca.language NOT ILIKE 'en%')
       AND NOT EXISTS (SELECT 1 FROM content_gen_channel_analysis cga WHERE cga.channel_id = gated.channel_id AND cga.language IS NOT NULL AND cga.language NOT ILIKE 'en%')) AS g_lang_analysis,
      (top_video_views > 0) AS g_topview_pos,
      (top_video_views::float / NULLIF(subscriber_count, 0) >= 5) AS g_view_sub_ratio,
      (top_video_views >= CASE
         WHEN age_days > 365 THEN 1000000
         WHEN age_days > 180 THEN  500000
         WHEN age_days >  90 THEN  200000
         ELSE                      100000 END) AS g_view_floor,
      (age_days <= 730) AS g_age,
      (top_video_posted_at >= NOW() - INTERVAL '12 months') AS g_recency,
      (videos_indexed >= 5) AS g_min_videos,
      (median_video_views::float / NULLIF(top_video_views, 0) >= 0.05) AS g_median_ratio
    FROM gated
  `;

  const res = await pool.query<GateRow>(sql, params);

  // First pass: collect SQL-gate fail reasons. Channels that clear ALL SQL
  // gates move on to the JS English gates.
  const evals: CgEval[] = [];
  const englishCandidates: Array<{ channel_id: string; channel_name: string | null; top_video_title: string | null }> = [];
  const byId = new Map<string, CgEval>();

  for (const r of res.rows) {
    const fails: CgFailReason[] = [];
    if (!r.g_enriched) fails.push('not_enriched');
    if (!r.g_subs_band) fails.push('subs_band');
    if (!r.g_not_used) fails.push('used_channel');
    if (!r.g_lang_analysis) fails.push('lang_analysis');
    if (!r.g_topview_pos) fails.push('topview_zero');
    if (!r.g_view_sub_ratio) fails.push('view_sub_ratio');
    if (!r.g_view_floor) fails.push('view_floor');
    if (!r.g_age) fails.push('age');
    if (!r.g_recency) fails.push('recency');
    if (!r.g_min_videos) fails.push('min_videos');
    if (!r.g_median_ratio) fails.push('median_ratio');

    // discovery.ts gate #13 (non-Latin script / foreign label) — only counts
    // if the SQL gates are otherwise clean (matches discoverChannels order:
    // SQL gates then the JS script filter).
    if (fails.length === 0 && isNonEnglishChannel(r.channel_name, r.top_video_title)) {
      fails.push('english_script');
    }

    const ev: CgEval = {
      channel_id: r.channel_id,
      eligible: false, // finalised after the franc gate below
      fail_reasons: fails,
      subscriber_count: r.subscriber_count == null ? null : parseInt(r.subscriber_count, 10),
      channel_name: r.channel_name,
      channel_handle: r.channel_handle,
      channel_avatar: r.channel_avatar,
      top_video_id: r.top_video_id,
      top_video_title: r.top_video_title,
      top_video_url: r.top_video_url,
      top_video_views: r.top_video_views == null ? null : parseInt(r.top_video_views, 10),
      channel_age_days: r.channel_age_days == null ? null : Math.round(parseFloat(r.channel_age_days)),
    };
    evals.push(ev);
    byId.set(r.channel_id, ev);
    if (fails.length === 0) {
      englishCandidates.push({ channel_id: r.channel_id, channel_name: r.channel_name, top_video_title: r.top_video_title });
    }
  }

  // discovery/drafts gate #14 — heuristic + franc over the channel's top ~12
  // titles. Reuse english-gate.ts verbatim (fetches titles + franc itself).
  if (englishCandidates.length > 0) {
    const { excluded } = await filterEnglishCandidates(englishCandidates);
    const excludedIds = new Set(excluded.map(c => c.channel_id).filter((x): x is string => !!x));
    for (const c of englishCandidates) {
      if (c.channel_id && excludedIds.has(c.channel_id)) {
        byId.get(c.channel_id)?.fail_reasons.push('english_gate');
      }
    }
  }

  for (const ev of evals) ev.eligible = ev.fail_reasons.length === 0;
  return evals;
}
