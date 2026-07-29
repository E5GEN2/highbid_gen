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
    'Find YouTube niches by meaning. Give a topic, style, or idea in plain language ' +
    '(e.g. "survival stories", "AI tool tutorials", "faceless history explainers") and get the ' +
    'closest niche clusters ranked by semantic similarity. Each niche is a discovered cluster of ' +
    'real channels/videos. Use the returned niche_id with the other niche_* tools to go deeper.',
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
    'List the top broad (macro) niches in the discovery library, sorted by activity. ' +
    'Good for open-ended exploration ("what niches are out there?"). Returns niche_id + headline ' +
    'stats; drill into any with the niche_* tools. For sub-niches inside one, use niche_children (coming).',
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
    'THE ENTRY POINT — call this first when the user is new, curious, or asks anything vague. Returns what the ' +
    'rofe.ai growth observatory is (the idea in one paragraph), live status numbers (channels under daily heartbeat, ' +
    'days of data, documented breakouts), and the curated learning path with which tool serves each step. ' +
    'Use it to orient the user and offer them a clear way in.',
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
        'rofe.ai watches YouTube channels from the moment they are tiny — often 0-10 subscribers — and records a daily heartbeat of their growth (subs, uploads, per-video views), as if each channel were our own. When one breaks out, its entire journey is documented day by day. You are here to learn from those journeys: what growing channels did, when, and what drove each jump — so you can apply the same patterns yourself. USE THE EXACT live_status NUMBERS below when presenting this — they are live and growing, and they are the credibility.',
      live_status: {
        channels_under_daily_heartbeat: parseInt(x.tracked, 10),
        daily_snapshots_recorded: parseInt(x.snaps, 10),
        days_of_data: parseInt(x.days, 10),
        recording_since: x.since,
        channels_with_per_video_tracking: parseInt(x.deep, 10),
        documented_breakouts_0_10_to_100plus: parseInt(breakouts.rows[0]?.n ?? '0', 10),
      },
      learning_path: [
        { step: 1, what: 'See real breakout journeys — day-by-day climbs from ~0 to 100+ subs', tool: 'growth_journeys' },
        { step: 2, what: "Zoom into one channel's story and what drove each jump", tool: 'channel_growth_series + growth_attribution' },
        { step: 3, what: 'Learn the playbook — what the winners have in common (cadence, youth, views, niches)', tool: 'growth_playbook' },
        { step: 4, what: 'Watch it live — channels accelerating right now', tool: 'growth_accelerating' },
        { step: 5, what: 'Find where to apply it — explore the niche library', tool: 'search_niches / browse_niches' },
      ],
      note: 'The study is young and grows every day — numbers above are live.',
    };
  },
};

export const TOOLS: McpTool[] = [start_here, search_niches, browse_niches, ...GROWTH_TOOLS];
