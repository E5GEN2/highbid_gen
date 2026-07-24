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

export const TOOLS: McpTool[] = [search_niches, browse_niches];
