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
    return { suspicious: true, reason: `This one is not a real success story. Its subscribers shot up to ${max} and then collapsed back to ${last} — that is the classic signature of bought subscribers being removed by YouTube. Do not copy what this channel did.` };
  }
  // frozen: same value repeated 3+ consecutive scans at a non-trivial level
  let run = 1;
  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === nums[i - 1]) { run++; if (run >= 3 && nums[i] > 50) return { suspicious: true, reason: `Treat this one with suspicion. The subscriber count sat at exactly ${nums[i]} for ${run} days in a row without moving. Real growth wobbles up and down a little every day; a number frozen this perfectly usually means the count is not genuine.` }; }
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

const METHOD_NOTE = 'How we know this is real: we check every one of these channels once a day and write down what we see. So every climb here is growth we actually watched happen, day by day — not a guess, and not a channel that was already big when we found it. Auto-generated music channels are left out.';

interface JourneyRow { channel_id: string; channel_name: string; s1: number; smax: number; s_last: number; days: number; series: string; age_days: number; }

// ── 1. growth_journeys — climbs at ANY starting size (§4.1 generalised) ────
// The stale-baseline guard scales with size: a stored count months out of date
// "corrects" by a large MULTIPLE on the second reading (WALTER 56→49,700), so we
// drop a channel whose 2nd reading is more than double+50 of its 1st. That keeps
// real climbs at every size while still excluding the correction artifact.
const ARTIFACT_GUARD = '(s.s2 <= s.s1 * 2 + 50)';

const BANDS: Record<string, [number, number]> = {
  any:          [0, 100000000],
  under_10:     [0, 9],
  '10_to_100':  [10, 99],
  '100_to_1k':  [100, 999],
  '1k_plus':    [1000, 100000000],
};

const growth_journeys: McpTool = {
  name: 'growth_journeys',
  description:
    'Shows real YouTube channels we watched actually grow — with the whole climb, day by day, like ' +
    '"4 → 6 → 15 → 31 → 140 subscribers". You can look at channels of any size: ones that started from nothing, ' +
    'ones already at a few hundred subscribers, or ones pushing past 1,000 and 10,000. Ask for a milestone ' +
    '(crossed 100 / 1,000 / 10,000 subscribers) or just the biggest gainers. Every channel here is one we check ' +
    'every single day, so these are climbs we watched happen. Channels that look like they bought fake subscribers ' +
    'are marked with a warning — never present those as success stories. Always show the user the actual climb.',
  inputSchema: {
    type: 'object',
    properties: {
      crossed: { type: 'integer', description: 'Only channels that broke through this subscriber milestone while we watched (e.g. 100, 1000, 10000).' },
      starting_size: { type: 'string', enum: ['any', 'under_10', '10_to_100', '100_to_1k', '1k_plus'], description: 'How big the channel was when we started watching. Default "any".' },
      min_gained: { type: 'integer', description: 'Only channels that gained at least this many subscribers while we watched.' },
      sort: { type: 'string', enum: ['most_gained', 'highest_reached', 'fastest_multiple'], description: 'Ranking. "most_gained" = biggest subscriber gain (default), "fastest_multiple" = grew the most times over.' },
      limit: { type: 'integer', description: 'How many channels (default 20, max 100).' },
      include_suspicious: { type: 'boolean', description: 'Include channels flagged as likely fake growth (still marked). Default true.' },
    },
  },
  handler: async (args) => {
    const band = BANDS[String(args.starting_size ?? 'any')] ?? BANDS.any;
    const crossed = args.crossed != null ? clampInt(args.crossed, 100, 1, 100000000) : null;
    const minGained = args.min_gained != null ? clampInt(args.min_gained, 0, 0, 100000000) : null;
    const limit = clampInt(args.limit, 20, 1, 100);
    const sortKey = String(args.sort ?? 'most_gained');
    const orderBy = sortKey === 'highest_reached' ? 's.smax DESC'
      : sortKey === 'fastest_multiple' ? '(s.s_last::float / GREATEST(s.s1,1)) DESC'
      : '(s.s_last - s.s1) DESC';

    const conds: string[] = [`s.s1 BETWEEN $1 AND $2`, ARTIFACT_GUARD,
      `sc.channel_name NOT ILIKE '% - Topic'`, `sc.channel_name NOT ILIKE '%VEVO'`];
    const params: (number | string)[] = [band[0], band[1]];
    if (crossed != null) { params.push(crossed); conds.push(`(s.s1 < $${params.length} AND s.smax >= $${params.length})`); }
    if (minGained != null) { params.push(minGained); conds.push(`(s.s_last - s.s1) >= $${params.length}`); }
    params.push(limit);

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
        WHERE ${conds.join(' AND ')}
        ORDER BY ${orderBy}
        LIMIT $${params.length}`,
      params,
    );
    const includeSus = args.include_suspicious !== false;
    const journeys = r.rows.map(j => {
      const flag = seriesFlag(j.series);
      const gained = Number(j.s_last) - Number(j.s1);
      const mult = Number(j.s1) > 0 ? Math.round((Number(j.s_last) / Number(j.s1)) * 10) / 10 : null;
      return {
        channel_id: j.channel_id,
        channel: j.channel_name,
        channel_age: `${Number(j.age_days)} days old`,
        started_at: `${j.s1} subscribers when we started watching`,
        subscribers_now: j.s_last,
        gained: `+${gained} subscribers${mult && mult >= 2 ? ` (${mult}x)` : ''}`,
        highest_reached: j.smax,
        we_have_watched_for: `${j.days} days`,
        the_climb: j.series.split('->').join(' → ') + ' subscribers',
        looks_fake: flag.suspicious,
        warning: flag.reason,
      };
    }).filter(j => includeSus || !j.looks_fake);
    const window = await dataWindow();
    return {
      window, how_we_know: METHOD_NOTE,
      showing: crossed ? `Channels that broke past ${crossed} subscribers while we watched` : 'Channels that gained the most subscribers while we watched',
      count: journeys.length, journeys,
    };
  },
};

// ── 1b. growth_milestones — how many crossed each level, by starting size ──
const growth_milestones: McpTool = {
  name: 'growth_milestones',
  description:
    'The big picture of everything we have watched: how many channels broke past 100, 1,000 and 10,000 subscribers ' +
    'while we were recording, broken down by how big they were when we found them. Use this to show someone the ' +
    'real scale of the dataset and to help them pick which kind of journey they want to study.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const pool = await getPool();
    const r = await pool.query<{ band: string; channels: string; grew: string; c100: string; c1k: string; c10k: string; best: string }>(
      `WITH s AS (
         SELECT channel_id,
                (ARRAY_AGG(subscriber_count ORDER BY day ASC))[1]  AS s1,
                (ARRAY_AGG(subscriber_count ORDER BY day ASC))[2]  AS s2,
                (ARRAY_AGG(subscriber_count ORDER BY day DESC))[1] AS s_last,
                MAX(subscriber_count) AS smax
           FROM channel_growth_snapshots WHERE subscriber_count IS NOT NULL
          GROUP BY channel_id HAVING COUNT(*) >= 2),
       c AS (SELECT s.* FROM s JOIN niche_spy_channels sc USING (channel_id)
              WHERE ${ARTIFACT_GUARD}
                AND sc.channel_name NOT ILIKE '% - Topic' AND sc.channel_name NOT ILIKE '%VEVO')
       SELECT CASE WHEN s1 < 10 THEN 'Found with under 10 subscribers'
                   WHEN s1 < 100 THEN 'Found with 10-100 subscribers'
                   WHEN s1 < 1000 THEN 'Found with 100-1,000 subscribers'
                   WHEN s1 < 10000 THEN 'Found with 1,000-10,000 subscribers'
                   ELSE 'Found with over 10,000 subscribers' END AS band,
              COUNT(*)::text AS channels,
              COUNT(*) FILTER (WHERE s_last > s1)::text AS grew,
              COUNT(*) FILTER (WHERE s1 < 100 AND smax >= 100)::text AS c100,
              COUNT(*) FILTER (WHERE s1 < 1000 AND smax >= 1000)::text AS c1k,
              COUNT(*) FILTER (WHERE s1 < 10000 AND smax >= 10000)::text AS c10k,
              COALESCE(MAX(s_last - s1),0)::text AS best
         FROM c GROUP BY 1 ORDER BY MIN(s1)`,
    );
    const window = await dataWindow();
    const rows = r.rows.map(x => ({
      channels_found_at_this_size: x.band,
      how_many: parseInt(x.channels, 10),
      how_many_gained_subscribers: parseInt(x.grew, 10),
      broke_past_100: parseInt(x.c100, 10),
      broke_past_1000: parseInt(x.c1k, 10),
      broke_past_10000: parseInt(x.c10k, 10),
      biggest_single_gain: `+${parseInt(x.best, 10)} subscribers`,
    }));
    const tot = (k: 'broke_past_100' | 'broke_past_1000' | 'broke_past_10000') => rows.reduce((a, b) => a + b[k], 0);
    return {
      window,
      headline: `While we have been recording, ${tot('broke_past_100')} channels broke past 100 subscribers, ${tot('broke_past_1000')} broke past 1,000, and ${tot('broke_past_10000')} broke past 10,000 — every one of those climbs captured day by day.`,
      by_starting_size: rows,
      how_we_know: METHOD_NOTE,
    };
  },
};

// ── 2. channel_growth_series — daily deltas for one channel (§4.2) ─────────
const channel_growth_series: McpTool = {
  name: 'channel_growth_series',
  description:
    'Follows one channel day by day: how many subscribers it had each day, how many it gained that day, and when it ' +
    'posted new videos. This is how you see exactly when a channel started taking off. Pair it with growth_attribution ' +
    'to find out which video caused the jump. Use a channel_id from growth_journeys or growth_accelerating.',
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
    if (rows.rows.length === 0) return { channel_id, note: "We haven't recorded any daily history for this channel yet — either we aren't watching it, or we only just started." };
    const series = rows.rows.map(r => r.subscriber_count).join('->');
    const flag = seriesFlag(series);
    return {
      channel_id,
      channel: meta.rows[0]?.channel_name ?? null,
      channel_age: meta.rows[0] ? `${Number(meta.rows[0].age_days)} days old` : null,
      we_have_watched_for: `${rows.rows.length} days`,
      the_climb: series.split('->').join(' → ') + ' subscribers',
      looks_fake: flag.suspicious,
      warning: flag.reason,
      day_by_day: rows.rows.map(r => ({
        date: r.day,
        subscribers: r.subscriber_count,
        subscribers_gained_that_day: r.subs_delta,
        videos_on_channel: r.video_count,
        new_videos_posted: r.uploads_added,
      })),
      how_we_know: METHOD_NOTE,
    };
  },
};

// ── 3. growth_attribution — which video drove growth (§4.3) ────────────────
const growth_attribution: McpTool = {
  name: 'growth_attribution',
  description:
    "Shows how each of a channel's videos performed over time, best first — so you can work out which video actually " +
    'brought the subscribers in. It also tells you whether each one was a Short or a longer video, which matters a lot: ' +
    'Shorts rack up cheap views, longer videos turn viewers into subscribers. We only track individual videos for ' +
    'channels that showed signs of life, so some channels will have nothing here yet.',
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
    if (r.rows.length === 0) return { channel_id, note: "We don't track this channel's individual videos yet — we only do that once a channel starts showing signs of life.", videos: [] };
    return {
      channel_id,
      videos_we_track: r.rows.length,
      worth_knowing: 'Views on Shorts come cheap from the algorithm; views on longer videos turn into subscribers far more often. If a video is marked "unknown" below, we simply have not checked its length yet.',
      videos: r.rows.map(v => ({
        title: v.title,
        format: v.is_short === true ? 'Short' : v.is_short === false ? 'Long-form video' : 'unknown',
        posted: v.posted,
        views_gained_while_watching: parseInt(v.views_gained, 10),
        view_growth: v.view_series.split('->').join(' → ') + ' views',
      })),
    };
  },
};

// ── 4. growth_outcomes — distribution of the tiny cohort (§4.4) ────────────
const growth_outcomes: McpTool = {
  name: 'growth_outcomes',
  description:
    'The honest answer to "what actually happens to tiny channels?" — of all the small channels we watch, how many ' +
    'never moved, how many lost subscribers, how many grew a little, and how many broke past 100 or 1,000 subscribers. ' +
    'Use this to give people a realistic picture instead of only showing the winners.',
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
    const FRIENDLY: Record<string, string> = {
      'flat': 'Never grew at all',
      'declined': 'Lost subscribers',
      'grew, under 100': 'Grew a bit, still under 100 subscribers',
      'crossed 100': 'Broke past 100 subscribers',
      'crossed 1K': 'Broke past 1,000 subscribers',
    };
    const dist = r.rows.map(x => ({ outcome: FRIENDLY[x.outcome] ?? x.outcome, channels: parseInt(x.n, 10) }));
    const total = dist.reduce((a, b) => a + b.channels, 0);
    const window = await dataWindow();
    return {
      window,
      tiny_channels_we_are_watching: total,
      what_happened_to_them: dist,
      reality_check: 'This is the honest picture: most tiny channels never really move. A handful climb past 100 subscribers, and a very small number go further. That is why the ones that DO break out are worth studying closely.',
      how_we_know: METHOD_NOTE,
    };
  },
};

// ── 5. growth_accelerating — channels rising right now (mission) ───────────
const growth_accelerating: McpTool = {
  name: 'growth_accelerating',
  description:
    'Shows which channels are gaining subscribers right now, ranked by how many they picked up in the last few days. ' +
    'This is the live view — who is heating up today. Channels that look like they bought subscribers are marked. ' +
    'Follow any of them with channel_growth_series to see the full story.',
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
      window, window_days: win, how_we_know: METHOD_NOTE,
      count: r.rows.length,
      channels: r.rows.map(c => {
        const flag = seriesFlag(c.series);
        return {
          channel_id: c.channel_id,
          channel: c.channel_name,
          channel_age: `${Number(c.age_days)} days old`,
          subscribers_gained: Number(c.gained),
          went_from: c.s_start,
          up_to: c.s_end,
          between: `${c.from_day} and ${c.to_day}`,
          the_climb: c.series.split('->').join(' → ') + ' subscribers',
          looks_fake: flag.suspicious,
          warning: flag.reason,
        };
      }),
    };
  },
};

// ── 6. growth_playbook — what the winners share, computed LIVE (§5) ────────
const growth_playbook: McpTool = {
  name: 'growth_playbook',
  description:
    'The big lesson: what the channels that grew did differently from the ones that did not. Worked out fresh every ' +
    'time from the channels we watch. Covers how often they posted, how new the channel was, whether their videos were ' +
    'picking up views, and what kind of content they made. This is the closest thing to "what should I actually do?" — ' +
    'and it comes from watching real channels, not from opinion.',
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
      window, how_we_know: METHOD_NOTE,
      patterns: {
        upload_cadence: {
          finding: 'The more videos a channel posted while we watched, the more likely it was to gain subscribers. This is the single strongest pattern we see.',
          buckets: cadence.rows.map(r => ({ bucket: r.bucket, channels: parseInt(r.n, 10), pct_gaining_subs: parseFloat(r.pct_gaining), avg_subs_gained_when_gaining: r.avg_gain ? parseFloat(r.avg_gain) : null })),
          caveat: 'One honest catch: channels that post nothing are often abandoned anyway, so some of this gap is simply dead channels. Posting a lot improves your odds — it does not guarantee anything.',
        },
        channel_age: {
          finding: 'Brand-new channels grow far more often than older ones. After roughly three months, most channels that have not taken off settle into a long flat stretch.',
          buckets: youth.rows.map(r => ({ bucket: r.bucket, channels: parseInt(r.n, 10), pct_gaining_subs: parseFloat(r.pct_gaining) })),
        },
        rising_views_to_subs: {
          finding: lift ? `Channels whose videos gained views grew subscribers ~${lift}x more often than those with flat views.` : 'Insufficient view data in window.',
          rising: rising ? { channels: parseInt(rising.n, 10), pct_gaining_subs: parseFloat(rising.pct_gaining) } : null,
          flat: flat ? { channels: parseInt(flat.n, 10), pct_gaining_subs: parseFloat(flat.pct_gaining) } : null,
        },
        breakout_niches: {
          finding: 'The kinds of content the breakout channels were making.',
          niches: nicheRows.rows.map(r => ({ niche: r.label, breakout_channels: parseInt(r.channels, 10) })),
          label_coverage: `${nicheCoverage.rows[0]?.covered ?? 0}/${nicheCoverage.rows[0]?.total ?? 0} breakout channels have a niche label — brand-new channels often aren't clustered/analyzed yet`,
          caveat: 'Only a couple of dozen channels have broken out so far, so treat this as an early hint rather than proof. What we keep seeing: faceless short-drama channels show up again and again.',
        },
      },
      reality_check: 'Doing all of this improves your chances — it does not make growth certain. Roughly 78 out of every 100 tiny channels we watch never really take off, no matter what they do.',
    };
  },
};

// ── ONE-CLICK COHORT ROUTES ───────────────────────────────────────────────
// growth_journeys is general-purpose (any starting size, any milestone), and its
// default starting_size='any' returns the biggest absolute gainers — which are
// usually channels that were ALREADY big when we found them. These zero-argument
// tools are the four size cohorts we report on, so an agent (or a person clicking
// once) lands on the right set without knowing any parameters. Each is
// artifact-guarded, requires real growth, and excludes auto-generated music
// channels. Cohort stats are computed live — the numbers move every day.

/** Shared cohort query: journeys whose FIRST FRESH reading fell in [lo,hi]. */
async function cohortJourneys(lo: number, hi: number, limit: number, order: 'reached' | 'gained') {
  const pool = await getPool();
  const orderBy = order === 'reached' ? 's.smax DESC' : '(s.s_last - s.s1) DESC';
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
      WHERE s.s1 BETWEEN $1 AND $2 AND ${ARTIFACT_GUARD}
        AND s.s_last > s.s1
        AND sc.channel_name NOT ILIKE '% - Topic' AND sc.channel_name NOT ILIKE '%VEVO'
      ORDER BY ${orderBy}
      LIMIT $3`,
    [lo, hi, limit],
  );
  return r.rows.map(j => {
    const flag = seriesFlag(j.series);
    const gained = Number(j.s_last) - Number(j.s1);
    const mult = Number(j.s1) > 0 ? Math.round((Number(j.s_last) / Number(j.s1)) * 10) / 10 : null;
    return {
      channel_id: j.channel_id,
      channel: j.channel_name,
      channel_age: `${Number(j.age_days)} days old`,
      caught_at: Number(j.s1),          // where we FOUND it (defines its group)
      subscribers_now: Number(j.s_last),
      gained: `+${gained} subscribers${mult && mult >= 2 ? ` (${mult}x)` : ''}`,
      highest_reached: Number(j.smax),
      we_have_watched_for: `${j.days} days`,
      the_climb: j.series.split('->').join(' → ') + ' subscribers',
      looks_fake: flag.suspicious,
      warning: flag.reason,
    };
  });
}

/** Live cohort stats for a band: how big it is and how often it actually grows.
 *  Computed per call because these move every day — never hardcode them. */
async function cohortStats(lo: number, hi: number) {
  const pool = await getPool();
  const r = await pool.query<{ total: string; grew: string; gained100: string; crossed100: string }>(
    `WITH s AS (
       SELECT channel_id,
              (ARRAY_AGG(subscriber_count ORDER BY day ASC))[1]  AS s1,
              (ARRAY_AGG(subscriber_count ORDER BY day ASC))[2]  AS s2,
              (ARRAY_AGG(subscriber_count ORDER BY day DESC))[1] AS s_last,
              MAX(subscriber_count) AS smax
         FROM channel_growth_snapshots
        WHERE subscriber_count IS NOT NULL
        GROUP BY channel_id
       HAVING COUNT(*) >= 2)
     SELECT COUNT(*)::text AS total,
            COUNT(*) FILTER (WHERE s.s_last > s.s1)::text AS grew,
            COUNT(*) FILTER (WHERE (s.s_last - s.s1) >= 100)::text AS gained100,
            COUNT(*) FILTER (WHERE s.s1 < 100 AND s.smax >= 100)::text AS crossed100
       FROM s WHERE s.s1 BETWEEN $1 AND $2 AND ${ARTIFACT_GUARD}`,
    [lo, hi],
  );
  const row = r.rows[0];
  const total = parseInt(row?.total ?? '0', 10);
  const grew = parseInt(row?.grew ?? '0', 10);
  return {
    channels_we_watch_in_this_size: total,
    how_many_grew_at_all: grew,
    pct_that_grew: total > 0 ? Math.round((grew / total) * 1000) / 10 : 0,
    how_many_gained_100_plus: parseInt(row?.gained100 ?? '0', 10),
    how_many_crossed_100_subs: parseInt(row?.crossed100 ?? '0', 10),
  };
}

interface BandSpec {
  tool: string; lo: number; hi: number; label: string;
  order: 'reached' | 'gained'; blurb: string; guidance: string;
}

/** The four STARTING-SIZE groups. The band is where we CAUGHT the channel — the
 *  journey is wherever it went from there (a channel caught at 4 subs that is now
 *  at 572 belongs to the 0-10 group but its journey is 4 → 572). Never describe a
 *  band as "the journey"; it is the starting point that defines the group. */
const COHORT_BANDS: BandSpec[] = [
  {
    tool: 'caught_at_0_to_10', lo: 0, hi: 9, label: 'GROUP: channels we caught at under 10 subscribers',
    order: 'reached',
    blurb: 'ONE CLICK — the group of channels we caught while they still had under 10 subscribers, and where each one has travelled since, day by day ("4 → 6 → 15 → 31 → 48 → 140 subscribers"). The 0-10 is where we FOUND them, not how far they got — some are now in the hundreds. This is the hardest group to grow and the most interesting, because we were watching before anything was happening.',
    guidance: 'Use for any question about tiny, brand-new, or from-scratch channels, and for the climb out of single digits.',
  },
  {
    tool: 'caught_at_10_to_100', lo: 10, hi: 99, label: 'GROUP: channels we caught at 10-100 subscribers',
    order: 'reached',
    blurb: 'ONE CLICK — the group of channels that had between 10 and 100 subscribers when we caught them, and where they have travelled since. 10-100 is the starting point, not the destination. This is the biggest group we watch and where first real momentum usually appears.',
    guidance: 'Use for questions about channels that had just started picking up their first subscribers.',
  },
  {
    tool: 'caught_at_100_to_200', lo: 100, hi: 199, label: 'GROUP: channels we caught at 100-200 subscribers',
    order: 'gained',
    blurb: 'ONE CLICK — the group of channels sitting between 100 and 200 subscribers when we caught them, and their climb since. They had already cleared the hardest hurdle, so most of these compound.',
    guidance: 'Use to show what happens after a channel breaks 100 — the stretch where growth becomes reliable.',
  },
  {
    tool: 'caught_at_200_to_500', lo: 200, hi: 500, label: 'GROUP: channels we caught at 200-500 subscribers',
    order: 'gained',
    blurb: 'ONE CLICK — the group of channels at 200-500 subscribers when we caught them, and how far they have climbed. The "already working, now it compounds" group — the most reliable growers we track.',
    guidance: 'Use to show sustained growth, and to contrast against the tiny group — starting traction makes an enormous difference.',
  },
];

function makeCohortTool(spec: BandSpec): McpTool {
  return {
    name: spec.tool,
    description:
      `${spec.blurb} ${spec.guidance} Every channel here is one we check once a day, so these are climbs we ` +
      'watched happen. Channels that look like they bought subscribers are marked with a warning — never present ' +
      'those as success stories. Always show the user the actual day-by-day climb.',
    inputSchema: { type: 'object', properties: {
      limit: { type: 'integer', description: 'How many channels (default 30, max 100).' },
    } },
    handler: async (args) => {
      const limit = clampInt(args.limit, 30, 1, 100);
      const [journeys, stats, window] = await Promise.all([
        cohortJourneys(spec.lo, spec.hi, limit, spec.order),
        cohortStats(spec.lo, spec.hi),
        dataWindow(),
      ]);
      return {
        window, how_we_know: METHOD_NOTE,
        group: spec.label,
        grouped_by: `Where the channel was when we CAUGHT it: ${spec.lo}-${spec.hi} subscribers. This is the starting point that defines the group — NOT the journey. Each channel below has travelled from that starting point to wherever it is now, and some are far past this range.`,
        group_reality: stats,
        showing: `The ones that grew — ${spec.order === 'reached' ? 'highest reached' : 'biggest gain'} first`,
        count: journeys.length,
        note: `Of the ${stats.channels_we_watch_in_this_size} channels we caught in this size range, ${stats.how_many_grew_at_all} (${stats.pct_that_grew}%) gained subscribers while we watched. Compare groups to see how much starting traction matters — the smaller the channel when caught, the longer the odds.`,
        journeys,
      };
    },
  };
}

const COHORT_TOOLS: McpTool[] = COHORT_BANDS.map(makeCohortTool);

export const GROWTH_TOOLS: McpTool[] = [...COHORT_TOOLS, growth_journeys, growth_milestones, channel_growth_series, growth_attribution, growth_outcomes, growth_accelerating, growth_playbook];
