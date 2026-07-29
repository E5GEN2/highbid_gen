/**
 * Tool registry for the rofe.ai niche-intelligence MCP server.
 * Each tool is a bounded, read-only query. Add tools here; the endpoint
 * (app/api/mcp/route.ts) exposes whatever is in TOOLS.
 *
 * v1 harness: search_niches + browse_niches (reuse existing lib fns / indexed
 * queries). The signature niche aggregations (scorecard / production_playbook /
 * trajectory) land next once this end-to-end path is proven on the box.
 */
import { getPool } from '@/lib/db';
import { searchNichesByText } from '@/lib/niche-search';
import { type McpTool, NICHE_LABEL_SQL, latestGlobalRunId, clampInt } from './core';
import { GROWTH_TOOLS } from './growth-tools';

interface ClusterRow {
  id: number; level: number; label: string;
  video_count: number; avg_views: number | null; total_views: string | number | null;
  avg_score: number | null; top_channels: string[] | null;
}

const search_niches: McpTool = {
  name: 'search_niches',
  description:
    'Find kinds of YouTube content by describing them in your own words — like "survival stories", "AI tool ' +
    'tutorials", or "faceless history channels". Returns the closest matching content areas we have found, along with ' +
    'the channels already making that content and how well it does.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Topic/idea to search for (2–300 chars).' },
      limit: { type: 'integer', description: 'Max niches to return (default 15, max 50).' },
      level: { type: 'integer', enum: [1, 2], description: 'Optional: 1 = broad macro-niche, 2 = sub-niche. Omit for both.' },
    },
    required: ['query'],
  },
  handler: async (args) => {
    const query = String(args.query ?? '').trim();
    if (!query) throw new Error('query is required');
    if (query.length > 300) throw new Error('query too long (max 300 chars)');
    const limit = clampInt(args.limit, 15, 1, 50);
    const level = args.level === 1 || args.level === 2 ? (args.level as number) : undefined;

    const { results, hitFromCache } = await searchNichesByText({ query, limit, level, minSimilarity: 0.15 });
    if (results.length === 0) return { query, count: 0, niches: [] };

    const pool = await getPool();
    const ids = results.map(r => r.clusterId);
    const simMap = new Map(results.map(r => [r.clusterId, r.similarity]));
    const rows = await pool.query<ClusterRow>(
      `SELECT c.id, c.level, ${NICHE_LABEL_SQL} AS label,
              c.video_count, c.avg_views, c.total_views, c.top_channels
         FROM niche_tree_clusters c
        WHERE c.id = ANY($1::int[])`,
      [ids],
    );
    const niches = rows.rows
      .map(r => ({
        niche_id: r.id,
        label: r.label,
        level: r.level,
        videos: r.video_count,
        avg_views: Math.round(Number(r.avg_views) || 0),
        top_channels: (r.top_channels ?? []).slice(0, 5),
        match: Math.round((simMap.get(r.id) ?? 0) * 100) / 100,
      }))
      .sort((a, b) => b.match - a.match);
    return { query, cached: hitFromCache, count: niches.length, niches };
  },
};

const browse_niches: McpTool = {
  name: 'browse_niches',
  description:
    'Browse the biggest kinds of content we have found on YouTube, most active first. Good for someone just ' +
    'looking around who asks "what is out there?". Shows how many videos each area has, typical view counts, ' +
    'and which channels lead it.',
  inputSchema: {
    type: 'object',
    properties: {
      sort: { type: 'string', enum: ['videos', 'views', 'score'], description: 'Ranking metric (default "videos").' },
      limit: { type: 'integer', description: 'How many niches (default 25, max 60).' },
    },
  },
  handler: async (args) => {
    const runId = await latestGlobalRunId();
    if (!runId) throw new Error('no active niche tree available');
    const sort = ['videos', 'views', 'score'].includes(String(args.sort)) ? String(args.sort) : 'videos';
    const limit = clampInt(args.limit, 25, 1, 60);
    const orderCol = sort === 'views' ? 'c.total_views' : sort === 'score' ? 'c.avg_score' : 'c.video_count';

    const pool = await getPool();
    const rows = await pool.query<ClusterRow>(
      `SELECT c.id, c.level, ${NICHE_LABEL_SQL} AS label,
              c.video_count, c.avg_views, c.total_views, c.avg_score, c.top_channels
         FROM niche_tree_clusters c
        WHERE c.run_id = $1 AND c.level = 1
        ORDER BY ${orderCol} DESC NULLS LAST
        LIMIT $2`,
      [runId, limit],
    );
    return {
      sort,
      count: rows.rows.length,
      niches: rows.rows.map(r => ({
        niche_id: r.id,
        label: r.label,
        videos: r.video_count,
        avg_views: Math.round(Number(r.avg_views) || 0),
        total_views: Number(r.total_views) || 0,
        avg_score: Math.round((Number(r.avg_score) || 0) * 10) / 10,
        top_channels: (r.top_channels ?? []).slice(0, 5),
      })),
    };
  },
};

const start_here: McpTool = {
  name: 'start_here',
  description:
    'START HERE — call this first whenever someone is new, curious, or asks something general. It explains what this ' +
    'is in plain words, gives the real live numbers (how many channels we check daily, how long we have been recording, ' +
    'how many have broken out so far), and lays out a simple step-by-step way for the person to start learning. ' +
    'Use it to welcome someone and give them an obvious first move.',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const pool = await getPool();
    // Split into cheap indexed counts (~70ms total). NOTE: do NOT count deep
    // channels via video_growth_snapshots -> niche_spy_videos (that join is a
    // 34s COUNT DISTINCT); the tracker's stage ladder gives the same answer
    // instantly (anything past 'liveness' gets per-video pulls).
    const [t, sn] = await Promise.all([
      pool.query<{ tracked: string; deep: string }>(
        `SELECT COUNT(*)::text AS tracked,
                COUNT(*) FILTER (WHERE stage <> 'liveness')::text AS deep
           FROM growth_tracked_channels`),
      pool.query<{ snaps: string; days: string; since: string | null }>(
        `SELECT COUNT(*)::text AS snaps, COUNT(DISTINCT day)::text AS days, MIN(day)::text AS since
           FROM channel_growth_snapshots`),
    ]);
    const r = { rows: [{ tracked: t.rows[0].tracked, deep: t.rows[0].deep, snaps: sn.rows[0].snaps, days: sn.rows[0].days, since: sn.rows[0].since }] };
    const breakouts = await pool.query<{ n: string }>(
      `WITH s AS (
         SELECT channel_id,
                (ARRAY_AGG(subscriber_count ORDER BY day ASC))[1]  AS s1,
                (ARRAY_AGG(subscriber_count ORDER BY day ASC))[2]  AS s2,
                MAX(subscriber_count) AS smax
           FROM channel_growth_snapshots WHERE subscriber_count IS NOT NULL
          GROUP BY channel_id HAVING COUNT(*) >= 2)
       SELECT COUNT(*)::text AS n FROM s JOIN niche_spy_channels sc USING (channel_id)
        WHERE s.s1 BETWEEN 0 AND 10 AND (s.s2 - s.s1) < 50 AND s.smax >= 100
          AND sc.channel_name NOT ILIKE '% - Topic' AND sc.channel_name NOT ILIKE '%VEVO'`,
    );
    const x = r.rows[0];
    return {
      what_this_is:
        "We find YouTube channels while they are still tiny — often with fewer than 10 subscribers — and then we check on every one of them once a day and write down what we see: how many subscribers they have, what they posted, and how their videos are doing. We treat them like they were our own channels. So when one of them takes off, we have the whole story, day by day: what they did, and when it started working. You are here to learn from those stories and use the same moves on your own channel. (Tell the user the real numbers below — they are live and they grow every day.)",
      live_status: {
        channels_we_check_every_day: parseInt(x.tracked, 10),
        daily_records_collected_so_far: parseInt(x.snaps, 10),
        days_we_have_been_recording: parseInt(x.days, 10),
        recording_since: x.since,
        channels_where_we_also_track_each_video: parseInt(x.deep, 10),
        channels_that_grew_from_under_10_to_over_100_subs: parseInt(breakouts.rows[0]?.n ?? '0', 10),
      },
      learning_path: [
        { step: 1, what: 'See channels that actually made it — the full climb, day by day, from almost nothing to 100+ subscribers', tool: 'growth_journeys' },
        { step: 2, what: 'Pick one of them and follow its story closely — which video made the subscribers start coming', tool: 'channel_growth_series + growth_attribution' },
        { step: 3, what: 'Learn what the ones that grew did differently — how often they posted, how new they were, what they made', tool: 'growth_playbook' },
        { step: 4, what: 'See who is growing right now, today', tool: 'growth_accelerating' },
        { step: 5, what: 'Find the kind of content worth making, and who is already winning at it', tool: 'search_niches / browse_niches' },
      ],
      note: 'We only started recording on 22 July, so this is early days — but the numbers above go up every single day.',
    };
  },
};

export const TOOLS: McpTool[] = [start_here, search_niches, browse_niches, ...GROWTH_TOOLS];
