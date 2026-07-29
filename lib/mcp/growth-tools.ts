/**
 * MCP tools for the Channel Growth Journeys study. These wrap the canonical
 * queries from docs/growth-watcher/mcp-agent-context.md with the study's
 * METHODOLOGY baked in, so answers are correct by construction:
 *   - snapshot-to-snapshot only (never first_caught_subs / growth_score — stale)
 *   - artifact-free cohort: s1 ∈ [0,10] AND (s2 - s1) < 50 (excludes the
 *     stale-baseline "correction" jump, e.g. WALTER 56→49,700)
 *   - exclude '- Topic' / VEVO auto-channels
 *   - bot-sub flagging (spike-then-crash / frozen counts, e.g. K9 4→9→25→1720→1720→30→34)
 *   - shorts vs long-form segmentation on views→subs
 *   - always report the observation window + base rate
 */
import { getPool } from '@/lib/db';
import { type McpTool, clampInt } from './core';

// ── shared helpers ─────────────────────────────────────────────────────────

/** Bot / artifact detector over a '->' subscriber series (methodology §3.3). */
function seriesFlag(series: string): { suspicious: boolean; reason?: string } {
  const nums = series.split('->').map(x => parseInt(x, 10)).filter(n => Number.isFinite(n));
  if (nums.length < 3) return { suspicious: false };
  const max = Math.max(...nums);
  const maxIdx = nums.indexOf(max);
  const last = nums[nums.length - 1];
  // spike-then-crash: a peak >=100 that later collapses below 40% of the peak
  if (max >= 100 && maxIdx < nums.length - 1 && last < 0.4 * max) {
    return { suspicious: true, reason: `spike-then-crash (peaked ${max}, now ${last}) — likely purchased subs or a YouTube purge, NOT organic growth` };
  }
  // frozen: same value repeated 3+ consecutive scans at a non-trivial level
  let run = 1;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === nums[i - 1]) { run++; if (run >= 3 && nums[i] > 50) return { suspicious: true, reason: `frozen at ${nums[i]} for ${run}+ consecutive scans — organic growth wobbles; a hard freeze is suspicious` }; }
    else run = 1;
  }
  return { suspicious: false };
}

/** The dataset's observation window — always reported alongside conclusions (§3.5). */
async function dataWindow(): Promise<{ start: string | null; end: string | null; days_of_data: number }> {
  const pool = await getPool();
  const r = await pool.query<{ start: string | null; end: string | null; days: string }>(
    `SELECT MIN(day)::text AS start, MAX(day)::text AS end, COUNT(DISTINCT day)::text AS days FROM channel_growth_snapshots`,
  );
  const row = r.rows[0];
  return { start: row?.start ?? null, end: row?.end ?? null, days_of_data: parseInt(row?.days ?? '0', 10) };
}

const METHOD_NOTE = 'Measured snapshot-to-snapshot (real daily observations); the stale first_caught_subs/growth_score fields are never used. Cohort excludes the stale-baseline correction artifact and auto-generated (-Topic/VEVO) channels.';

interface JourneyRow { channel_id: string; channel_name: string; s1: number; smax: number; s_last: number; days: number; series: string; age_days: number; }

// ── 1. growth_journeys — the artifact-free breakout cohort (§4.1) ──────────
const growth_journeys: McpTool = {
  name: 'growth_journeys',
  description:
    'The core Channel Growth Watcher tool. Returns REAL, artifact-free growth journeys of channels first ' +
    'observed tiny (0–10 subs) — measured snapshot-to-snapshot, so the day-by-day climb (e.g. "4→6→15→31→48→140") ' +
    'is genuine, not a stale-baseline illusion. Default surfaces the 0-10 → 100+ breakouts. Each journey includes ' +
    'the verbatim subscriber series, channel age, and a `suspicious` flag for bot-sub / purge patterns (spike-then-crash, ' +
    'frozen counts) which must NOT be presented as successes. Always show the series and state the observation window.',
  inputSchema: {
    type: 'object',
    properties: {
      min_peak_subs: { type: 'integer', description: 'Only journeys whose peak subs reached at least this (default 100 = the classic 0-10→100+ breakout). Set 1 to include all tiny-caught channels.' },
      limit: { type: 'integer', description: 'Max journeys (default 30, max 100).' },
      include_suspicious: { type: 'boolean', description: 'Include bot-flagged journeys in the list (still flagged). Default true — they are flagged, not hidden.' },
    },
  },
  handler: async (args) => {
    const minPeak = clampInt(args.min_peak_subs, 100, 1, 100_000_000);
    const limit = clampInt(args.limit, 30, 1, 100);
    const pool = await getPool();
    const r = await pool.query<JourneyRow>(
      `WITH s AS (
         SELECT channel_id,
                (ARRAY_AGG(subscriber_count ORDER BY day ASC))[1]  AS s1,
                (ARRAY_AGG(subscriber_count ORDER BY day ASC))[2]  AS s2,
                (ARRAY_AGG(subscriber_count ORDER BY day DESC))[1] AS s_last,
                MAX(subscriber_count) AS smax,
                COUNT(*) AS days,
                STRING_AGG(subscriber_count::text, '->' ORDER BY day) AS series
           FROM channel_growth_snapshots
          WHERE subscriber_count IS NOT NULL
          GROUP BY channel_id
         HAVING COUNT(*) >= 2)
       SELECT s.channel_id, sc.channel_name, s.s1, s.smax, s.s_last, s.days, s.series,
              (NOW()::date - sc.channel_created_at::date) AS age_days
         FROM s JOIN niche_spy_channels sc USING (channel_id)
        WHERE s.s1 BETWEEN 0 AND 10
          AND (s.s2 - s.s1) < 50
          AND sc.channel_name NOT ILIKE '% - Topic'
          AND sc.channel_name NOT ILIKE '%VEVO'
          AND s.smax >= $1
        ORDER BY s.smax DESC
        LIMIT $2`,
      [minPeak, limit],
    );
    const includeSus = args.include_suspicious !== false;
    const journeys = r.rows.map(j => {
      const flag = seriesFlag(j.series);
      return {
        channel_id: j.channel_id, channel: j.channel_name, age_days: Number(j.age_days),
        caught_at_subs: j.s1, peak_subs: j.smax, current_subs: j.s_last, days_tracked: j.days,
        series: j.series, suspicious: flag.suspicious, flag: flag.reason,
      };
    }).filter(j => includeSus || !j.suspicious);
    const window = await dataWindow();
    return {
      window, methodology: METHOD_NOTE,
      base_rate_note: '~78% of tiny channels stay flat; escaping 0-10 → 100+ is a rare fat-tail event (~0.1%/week). Report distributions, not averages.',
      count: journeys.length, journeys,
    };
  },
};

// ── 2. channel_growth_series — daily deltas for one channel (§4.2) ─────────
const channel_growth_series: McpTool = {
  name: 'channel_growth_series',
  description:
    "A single tracked channel's day-by-day growth: subscriber count each day, the sub delta, and uploads added — " +
    'the step-by-step story. Pair the sub-jump days with growth_attribution to see which video drove them. Includes a ' +
    'suspicious-pattern flag (bot subs / purge). Use the channel_id from growth_journeys / growth_accelerating.',
  inputSchema: {
    type: 'object',
    properties: { channel_id: { type: 'string', description: 'YouTube channel id (from another growth tool).' } },
    required: ['channel_id'],
  },
  handler: async (args) => {
    const channel_id = String(args.channel_id ?? '').trim();
    if (!channel_id) throw new Error('channel_id is required');
    const pool = await getPool();
    const meta = await pool.query<{ channel_name: string; age_days: number }>(
      `SELECT channel_name, (NOW()::date - channel_created_at::date) AS age_days FROM niche_spy_channels WHERE channel_id=$1`, [channel_id],
    );
    const rows = await pool.query<{ day: string; subscriber_count: number; subs_delta: number | null; video_count: number; uploads_added: number | null }>(
      `SELECT day::text, subscriber_count,
              subscriber_count - LAG(subscriber_count) OVER (ORDER BY day) AS subs_delta,
              video_count,
              video_count      - LAG(video_count)      OVER (ORDER BY day) AS uploads_added
         FROM channel_growth_snapshots WHERE channel_id=$1 ORDER BY day`, [channel_id],
    );
    if (rows.rows.length === 0) return { channel_id, error: 'no growth snapshots for this channel (not tracked, or caught too recently)' };
    const series = rows.rows.map(r => r.subscriber_count).join('->');
    const flag = seriesFlag(series);
    return {
      channel_id, channel: meta.rows[0]?.channel_name ?? null, age_days: meta.rows[0] ? Number(meta.rows[0].age_days) : null,
      days_tracked: rows.rows.length, series, suspicious: flag.suspicious, flag: flag.reason,
      daily: rows.rows.map(r => ({ day: r.day, subs: r.subscriber_count, subs_delta: r.subs_delta, videos: r.video_count, uploads_added: r.uploads_added })),
      methodology: METHOD_NOTE,
    };
  },
};

// ── 3. growth_attribution — which video drove growth (§4.3) ────────────────
const growth_attribution: McpTool = {
  name: 'growth_attribution',
  description:
    "For one channel, each video's view trajectory (ranked by views gained) so you can attribute subscriber jumps to " +
    'the uploads that preceded them. Segments Shorts vs long-form (`is_short`) — long-form converts to subs far better. ' +
    'Coverage is partial (per-video history exists only for deep-tracked channels); the tool reports how many videos it has.',
  inputSchema: {
    type: 'object',
    properties: {
      channel_id: { type: 'string', description: 'YouTube channel id.' },
      limit: { type: 'integer', description: 'Max videos (default 15, max 50).' },
    },
    required: ['channel_id'],
  },
  handler: async (args) => {
    const channel_id = String(args.channel_id ?? '').trim();
    if (!channel_id) throw new Error('channel_id is required');
    const limit = clampInt(args.limit, 15, 1, 50);
    const pool = await getPool();
    const r = await pool.query<{ title: string; is_short: boolean | null; posted: string | null; view_series: string; views_gained: string }>(
      `SELECT v.title, v.is_short, v.posted_at::date::text AS posted,
              STRING_AGG(vs.view_count::text, '->' ORDER BY vs.day) AS view_series,
              (MAX(vs.view_count) - MIN(vs.view_count))::text        AS views_gained
         FROM video_growth_snapshots vs
         JOIN niche_spy_videos v ON v.id = vs.video_id
        WHERE v.channel_id = $1
        GROUP BY v.id, v.title, v.is_short, v.posted_at
        ORDER BY (MAX(vs.view_count) - MIN(vs.view_count)) DESC
        LIMIT $2`, [channel_id, limit],
    );
    if (r.rows.length === 0) return { channel_id, coverage: 'no per-video history — this channel is not deep-tracked (only pulse+ and the <25-sub genesis cohort get per-video pulls)', videos: [] };
    return {
      channel_id, video_count_covered: r.rows.length,
      shorts_note: 'Shorts views are algorithmically cheap; long-form converts to subs far better. is_short is NULL until backfilled — do not assume.',
      videos: r.rows.map(v => ({ title: v.title, is_short: v.is_short, posted: v.posted, views_gained: parseInt(v.views_gained, 10), view_series: v.view_series })),
    };
  },
};

// ── 4. growth_outcomes — distribution of the tiny cohort (§4.4) ────────────
const growth_outcomes: McpTool = {
  name: 'growth_outcomes',
  description:
    'The outcome distribution for the artifact-free tiny-caught cohort — how many stayed flat, declined, grew a little, ' +
    'crossed 100, or crossed 1K. This is the honest "what happened to the channels we caught tiny?" answer: a fat-tail ' +
    'lottery where most stay flat and a rare few explode. Reports the observation window and the base rate.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const pool = await getPool();
    const r = await pool.query<{ outcome: string; n: string }>(
      `WITH s AS (
         SELECT channel_id,
                (ARRAY_AGG(subscriber_count ORDER BY day ASC))[1]  AS s1,
                (ARRAY_AGG(subscriber_count ORDER BY day ASC))[2]  AS s2,
                (ARRAY_AGG(subscriber_count ORDER BY day DESC))[1] AS s_last
           FROM channel_growth_snapshots WHERE subscriber_count IS NOT NULL
          GROUP BY channel_id HAVING COUNT(*) >= 2),
       journeys AS (
         SELECT s.* FROM s JOIN niche_spy_channels sc USING (channel_id)
          WHERE s.s1 BETWEEN 0 AND 10 AND (s.s2 - s.s1) < 50
            AND sc.channel_name NOT ILIKE '% - Topic' AND sc.channel_name NOT ILIKE '%VEVO')
       SELECT CASE WHEN s_last = s1 THEN 'flat'
                   WHEN s_last < s1 THEN 'declined'
                   WHEN s_last < 100 THEN 'grew, under 100'
                   WHEN s_last < 1000 THEN 'crossed 100'
                   ELSE 'crossed 1K' END AS outcome,
              COUNT(*)::text AS n
         FROM journeys GROUP BY 1 ORDER BY 1`,
    );
    const dist = r.rows.map(x => ({ outcome: x.outcome, channels: parseInt(x.n, 10) }));
    const total = dist.reduce((a, b) => a + b.channels, 0);
    const window = await dataWindow();
    return {
      window, cohort_size: total, distribution: dist,
      base_rate: '~78% of tiny channels stay flat; ~0.1%/week escape 0-10 → 100+. Averages mislead — this is a fat-tail phenomenon; report the tail.',
      methodology: METHOD_NOTE,
    };
  },
};

// ── 5. growth_accelerating — channels rising right now (mission) ───────────
const growth_accelerating: McpTool = {
  name: 'growth_accelerating',
  description:
    'Tracked channels gaining subscribers RIGHT NOW — ranked by real subscriber gain over the last N days ' +
    '(snapshot-to-snapshot, so no stale-baseline illusions). Excludes -Topic/VEVO and flags bot-sub patterns. ' +
    'Use to answer "which channels are accelerating?" then drill in with channel_growth_series / growth_attribution.',
  inputSchema: {
    type: 'object',
    properties: {
      window_days: { type: 'integer', description: 'Look-back window in days (default 7, max 90).' },
      limit: { type: 'integer', description: 'Max channels (default 25, max 100).' },
    },
  },
  handler: async (args) => {
    const win = clampInt(args.window_days, 7, 1, 90);
    const limit = clampInt(args.limit, 25, 1, 100);
    const pool = await getPool();
    const r = await pool.query<{ channel_id: string; channel_name: string; s_start: number; s_end: number; from_day: string; to_day: string; pts: number; series: string; age_days: number; gained: number }>(
      `WITH w AS (
         SELECT channel_id, day, subscriber_count,
                MAX(day) OVER (PARTITION BY channel_id) AS last_day
           FROM channel_growth_snapshots WHERE subscriber_count IS NOT NULL),
       vel AS (
         SELECT channel_id,
                (ARRAY_AGG(subscriber_count ORDER BY day ASC))[1]  AS s_start,
                (ARRAY_AGG(subscriber_count ORDER BY day DESC))[1] AS s_end,
                MIN(day)::text AS from_day, MAX(day)::text AS to_day,
                COUNT(*) AS pts,
                STRING_AGG(subscriber_count::text, '->' ORDER BY day) AS series
           FROM w WHERE day >= last_day - ($1::int)
          GROUP BY channel_id HAVING COUNT(*) >= 2)
       SELECT vel.channel_id, sc.channel_name, vel.s_start, vel.s_end, vel.from_day, vel.to_day, vel.pts, vel.series,
              (NOW()::date - sc.channel_created_at::date) AS age_days,
              (vel.s_end - vel.s_start) AS gained
         FROM vel JOIN niche_spy_channels sc USING (channel_id)
        WHERE sc.channel_name NOT ILIKE '% - Topic' AND sc.channel_name NOT ILIKE '%VEVO'
          AND (vel.s_end - vel.s_start) > 0
        ORDER BY gained DESC
        LIMIT $2`, [win, limit],
    );
    const window = await dataWindow();
    return {
      window, window_days: win, methodology: METHOD_NOTE,
      count: r.rows.length,
      channels: r.rows.map(c => {
        const flag = seriesFlag(c.series);
        return {
          channel_id: c.channel_id, channel: c.channel_name, age_days: Number(c.age_days),
          subs_gained: Number(c.gained), from: c.s_start, to: c.s_end, over: `${c.from_day}…${c.to_day}`,
          scans: c.pts, series: c.series, suspicious: flag.suspicious, flag: flag.reason,
        };
      }),
    };
  },
};

// ── 6. growth_playbook — what the winners share, computed LIVE (§5) ────────
const growth_playbook: McpTool = {
  name: 'growth_playbook',
  description:
    'The learning capstone: what the growing channels have in common, computed live across the artifact-free tracked ' +
    'cohort. Returns four evidence-backed patterns — (1) upload cadence vs share of channels gaining subs, (2) channel ' +
    'age (youth advantage / stagnation valley), (3) rising video views → subscriber growth lift, (4) which niches the ' +
    'breakouts cluster in — each with counts and honest caveats. This is the "what should I do?" answer, grounded in ' +
    'observed journeys, not advice.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const pool = await getPool();
    // Artifact-free per-channel aggregates over each channel's own observed window.
    const baseCte = `
      WITH per AS (
        SELECT channel_id,
               (ARRAY_AGG(subscriber_count ORDER BY day ASC))[1]  AS s1,
               (ARRAY_AGG(subscriber_count ORDER BY day ASC))[2]  AS s2,
               (ARRAY_AGG(subscriber_count ORDER BY day DESC))[1] AS s_last,
               (ARRAY_AGG(total_views ORDER BY day ASC))[1]       AS v_first,
               (ARRAY_AGG(total_views ORDER BY day DESC))[1]      AS v_last,
               (ARRAY_AGG(video_count ORDER BY day DESC))[1]
                 - (ARRAY_AGG(video_count ORDER BY day ASC))[1]   AS uploads_added,
               MAX(subscriber_count) AS smax
          FROM channel_growth_snapshots
         WHERE subscriber_count IS NOT NULL
         GROUP BY channel_id
        HAVING COUNT(*) >= 2),
      cohort AS (
        SELECT per.*, sc.channel_created_at
          FROM per JOIN niche_spy_channels sc USING (channel_id)
         WHERE (per.s2 - per.s1) < 50
           AND sc.channel_name NOT ILIKE '% - Topic'
           AND sc.channel_name NOT ILIKE '%VEVO')`;

    const [cadence, youth, viewsLift] = await Promise.all([
      pool.query<{ bucket: string; n: string; pct_gaining: string; avg_gain: string | null }>(
        `${baseCte}
         SELECT CASE WHEN COALESCE(uploads_added,0) <= 0 THEN '0 uploads'
                     WHEN uploads_added <= 2 THEN '1-2 uploads'
                     WHEN uploads_added <= 5 THEN '3-5 uploads'
                     ELSE '6+ uploads' END AS bucket,
                COUNT(*)::text AS n,
                ROUND(100.0 * COUNT(*) FILTER (WHERE s_last > s1) / COUNT(*), 1)::text AS pct_gaining,
                ROUND(COALESCE(AVG(s_last - s1) FILTER (WHERE s_last > s1), 0), 1)::text AS avg_gain
           FROM cohort GROUP BY 1 ORDER BY 1`),
      pool.query<{ bucket: string; n: string; pct_gaining: string }>(
        `${baseCte}
         SELECT CASE WHEN channel_created_at IS NULL THEN 'unknown age'
                     WHEN NOW() - channel_created_at <= INTERVAL '30 days'  THEN '0-30 days old'
                     WHEN NOW() - channel_created_at <= INTERVAL '90 days'  THEN '31-90 days'
                     WHEN NOW() - channel_created_at <= INTERVAL '365 days' THEN '91-365 days'
                     ELSE 'over 1 year' END AS bucket,
                COUNT(*)::text AS n,
                ROUND(100.0 * COUNT(*) FILTER (WHERE s_last > s1) / COUNT(*), 1)::text AS pct_gaining
           FROM cohort GROUP BY 1 ORDER BY 1`),
      pool.query<{ views_rising: boolean; n: string; pct_gaining: string }>(
        `${baseCte}
         SELECT (v_last > v_first) AS views_rising,
                COUNT(*)::text AS n,
                ROUND(100.0 * COUNT(*) FILTER (WHERE s_last > s1) / COUNT(*), 1)::text AS pct_gaining
           FROM cohort WHERE v_first IS NOT NULL AND v_last IS NOT NULL
           GROUP BY 1 ORDER BY 1`),
    ]);

    // Breakout niches. Breakout channels are usually brand-new, so their videos
    // are often not yet in the clustering run's assignments — merge two label
    // sources (cluster labels + channel_analysis niches) and report coverage.
    const nicheRows = await pool.query<{ label: string; channels: string }>(
      `${baseCte},
       breakouts AS (SELECT channel_id FROM cohort WHERE s1 BETWEEN 0 AND 10 AND smax >= 100),
       cluster_labels AS (
         SELECT COALESCE(NULLIF(c.label,''), c.ai_label, c.auto_label) AS label, v.channel_id
           FROM breakouts b
           JOIN niche_spy_videos v ON v.channel_id = b.channel_id
           JOIN niche_tree_assignments ta ON ta.video_id = v.id
           JOIN niche_tree_clusters c ON c.id = ta.cluster_id AND c.level = 1),
       analysis_labels AS (
         SELECT ca.niche AS label, ca.channel_id
           FROM breakouts b JOIN channel_analysis ca USING (channel_id)
          WHERE ca.niche IS NOT NULL AND ca.niche <> '')
       SELECT label, COUNT(DISTINCT channel_id)::text AS channels
         FROM (SELECT * FROM cluster_labels UNION ALL SELECT * FROM analysis_labels) x
        GROUP BY 1 ORDER BY COUNT(DISTINCT channel_id) DESC LIMIT 8`,
    );
    const nicheCoverage = await pool.query<{ covered: string; total: string }>(
      `${baseCte},
       breakouts AS (SELECT channel_id FROM cohort WHERE s1 BETWEEN 0 AND 10 AND smax >= 100)
       SELECT (SELECT COUNT(*) FROM breakouts b WHERE EXISTS (SELECT 1 FROM channel_analysis ca WHERE ca.channel_id=b.channel_id AND ca.niche IS NOT NULL)
                  OR EXISTS (SELECT 1 FROM niche_spy_videos v JOIN niche_tree_assignments ta ON ta.video_id=v.id WHERE v.channel_id=b.channel_id))::text AS covered,
              (SELECT COUNT(*) FROM breakouts)::text AS total`,
    );

    const window = await dataWindow();
    const rising = viewsLift.rows.find(x => x.views_rising === true);
    const flat = viewsLift.rows.find(x => x.views_rising === false);
    const lift = rising && flat && parseFloat(flat.pct_gaining) > 0
      ? Math.round((parseFloat(rising.pct_gaining) / parseFloat(flat.pct_gaining)) * 10) / 10 : null;

    return {
      window, methodology: METHOD_NOTE,
      patterns: {
        upload_cadence: {
          finding: 'Posting more in the observed window strongly tracks with gaining subscribers.',
          buckets: cadence.rows.map(r => ({ bucket: r.bucket, channels: parseInt(r.n, 10), pct_gaining_subs: parseFloat(r.pct_gaining), avg_subs_gained_when_gaining: r.avg_gain ? parseFloat(r.avg_gain) : null })),
          caveat: 'Partly selection: channels posting nothing are often abandoned. Cadence correlates; it does not guarantee.',
        },
        channel_age: {
          finding: 'Young channels win — momentum fades into a stagnation valley after ~3 months.',
          buckets: youth.rows.map(r => ({ bucket: r.bucket, channels: parseInt(r.n, 10), pct_gaining_subs: parseFloat(r.pct_gaining) })),
        },
        rising_views_to_subs: {
          finding: lift ? `Channels whose videos gained views grew subscribers ~${lift}x more often than those with flat views.` : 'Insufficient view data in window.',
          rising: rising ? { channels: parseInt(rising.n, 10), pct_gaining_subs: parseFloat(rising.pct_gaining) } : null,
          flat: flat ? { channels: parseInt(flat.n, 10), pct_gaining_subs: parseFloat(flat.pct_gaining) } : null,
        },
        breakout_niches: {
          finding: 'Where the 0-10 → 100+ breakouts concentrate (merged cluster + analysis labels).',
          niches: nicheRows.rows.map(r => ({ niche: r.label, breakout_channels: parseInt(r.channels, 10) })),
          label_coverage: `${nicheCoverage.rows[0]?.covered ?? 0}/${nicheCoverage.rows[0]?.total ?? 0} breakout channels have a niche label — brand-new channels often aren't clustered/analyzed yet`,
          caveat: 'Small n — the breakout cohort is a couple dozen channels; treat as a signal, not a law. Known qualitative signal: faceless short-drama dominates the early breakouts.',
        },
      },
      base_rate: '~78% of tiny channels stay flat. The playbook shifts odds; it does not defeat the fat tail.',
    };
  },
};

export const GROWTH_TOOLS: McpTool[] = [growth_journeys, channel_growth_series, growth_attribution, growth_outcomes, growth_accelerating, growth_playbook];
