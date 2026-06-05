/**
 * Niche identity for seed-mode agents.
 *
 * The xgodo niche-spy bot, when started from a seed video URL, carries a
 * rofe-generated `nicheId` in its task input. Several seed URLs that
 * belong to the same niche share one nicheId — that's the grouping /
 * identity key (analogous to `keyword` for keyword-mode tasks).
 *
 * This module mints nicheIds and maps them to human labels (agent_niches
 * table) so the monitor can display "Sumerian tablets" instead of the
 * opaque id.
 */

import { getPool } from './db';

export interface AgentNiche {
  niche_id: string;
  label: string;
  created_from: string;
  seed_urls: string[];
  created_at: string;
}

/**
 * Mint a compact, stable, URL-safe nicheId. Format: `nd_<base36 time>_<rand>`.
 * Opaque on purpose — the human name lives in agent_niches.label.
 *
 * We avoid Date.now()/Math.random reproducibility concerns here because
 * this only runs at deploy time (not inside a replayable workflow), so
 * non-determinism is fine and desired (each mint is unique).
 */
export function mintNicheId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 7);
  return `nd_${t}_${r}`;
}

/**
 * Derive a reasonable label from a seed video URL or title when the
 * operator didn't supply one. Falls back to the video id.
 */
export function deriveLabel(opts: { title?: string | null; seedUrl?: string | null }): string {
  if (opts.title && opts.title.trim()) {
    return opts.title.trim().slice(0, 80);
  }
  if (opts.seedUrl) {
    const id = extractVideoId(opts.seedUrl);
    if (id) return `seed ${id}`;
  }
  return 'untitled niche';
}

/** Pull the YouTube video id out of a watch/shorts/youtu.be URL. */
export function extractVideoId(url: string): string | null {
  if (!url) return null;
  // youtu.be/<id>
  let m = url.match(/youtu\.be\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  // /shorts/<id>
  m = url.match(/\/shorts\/([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  // watch?v=<id>
  m = url.match(/[?&]v=([A-Za-z0-9_-]{11})/);
  if (m) return m[1];
  return null;
}

/**
 * Create a new niche row and return its nicheId. Records the first seed
 * URL. created_from tags the origin (manual / novelty_seed / content_gen).
 */
export async function createNiche(opts: {
  label: string;
  seedUrl?: string | null;
  createdFrom?: string;
}): Promise<string> {
  const pool = await getPool();
  const nicheId = mintNicheId();
  await pool.query(
    `INSERT INTO agent_niches (niche_id, label, created_from, seed_urls)
     VALUES ($1, $2, $3, $4)`,
    [
      nicheId,
      opts.label.slice(0, 200),
      opts.createdFrom ?? 'manual',
      opts.seedUrl ? [opts.seedUrl] : [],
    ],
  );
  return nicheId;
}

/**
 * Resolve a nicheId to its niche row. Returns null if unknown (e.g. a
 * task whose niche was created outside rofe).
 */
export async function getNiche(nicheId: string): Promise<AgentNiche | null> {
  const pool = await getPool();
  const r = await pool.query<AgentNiche>(
    `SELECT niche_id, label, created_from, seed_urls, created_at::text
       FROM agent_niches WHERE niche_id = $1`,
    [nicheId],
  );
  return r.rows[0] ?? null;
}

/** Batch label lookup for the monitor — nicheId → label. */
export async function getNicheLabels(nicheIds: string[]): Promise<Map<string, AgentNiche>> {
  if (nicheIds.length === 0) return new Map();
  const pool = await getPool();
  const r = await pool.query<AgentNiche>(
    `SELECT niche_id, label, created_from, seed_urls, created_at::text
       FROM agent_niches WHERE niche_id = ANY($1::text[])`,
    [nicheIds],
  );
  return new Map(r.rows.map((row) => [row.niche_id, row]));
}

/**
 * Record an additional seed URL on an existing niche (idempotent — won't
 * duplicate). Used when the operator deploys another seed under the same
 * niche.
 */
export async function addSeedUrlToNiche(nicheId: string, seedUrl: string): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE agent_niches
        SET seed_urls = (
              SELECT ARRAY(SELECT DISTINCT unnest(seed_urls || ARRAY[$2]))
            ),
            updated_at = NOW()
      WHERE niche_id = $1`,
    [nicheId, seedUrl],
  );
}

/** List recent niches for the deploy UI's "add to existing niche" picker. */
export async function listNiches(limit = 100): Promise<AgentNiche[]> {
  const pool = await getPool();
  const r = await pool.query<AgentNiche>(
    `SELECT niche_id, label, created_from, seed_urls, created_at::text
       FROM agent_niches ORDER BY updated_at DESC LIMIT $1`,
    [limit],
  );
  return r.rows;
}
