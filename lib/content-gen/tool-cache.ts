/**
 * Tool-versioned asset cache.
 *
 * Producer calls `lookupCache(tool, args)` BEFORE running a tool. If a
 * previous run with the same (tool, version, args_hash) succeeded and
 * its assets are still on-disk, returns the cached output. Otherwise
 * returns null → producer runs the tool live, then calls `storeCache`
 * to persist the result for future renders.
 *
 * Cache key = sha256(tool ":" version ":" canonical-json(args minus
 * cache_key_excludes)). Canonical JSON sorts object keys recursively
 * so {a:1,b:2} and {b:2,a:1} hash identically.
 *
 * Storage table: content_gen_tool_cache (initSchema in lib/db.ts).
 * Columns: tool, version, args_hash UNIQUE, output_jsonb, asset_paths
 * (TEXT[]), created_at, last_used_at, hit_count.
 */

import crypto from 'crypto';
import fs from 'fs/promises';
import { getPool } from '../db';
import { TOOLS_BY_NAME } from './tools';

export interface CachedToolOutput {
  output: Record<string, unknown>;
  /** Local on-disk paths the cached output references. We verify they
   *  exist before serving the cache; if any are missing the entry is
   *  invalidated (deleted) and we return null so the tool re-runs. */
  asset_paths: string[];
  /** Diagnostic info — caller can include in the gem row so the GUI shows
   *  "cached from job N at YYYY-MM-DD". */
  origin: { row_id: number; created_at: Date; hit_count: number };
}

/** Sort object keys recursively. Returns the same primitive for non-objects. */
function canonicalize(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(canonicalize);
  const keys = Object.keys(v as Record<string, unknown>).sort();
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = canonicalize((v as Record<string, unknown>)[k]);
  return out;
}

/** Strip excluded fields then return a canonical JSON string suitable for hashing. */
function argsToCacheKey(tool: string, args: Record<string, unknown>): string {
  const spec = TOOLS_BY_NAME[tool];
  const excludes = new Set(spec?.cache_key_excludes ?? []);
  const filtered: Record<string, unknown> = {};
  for (const k of Object.keys(args)) {
    if (!excludes.has(k)) filtered[k] = args[k];
  }
  return JSON.stringify(canonicalize(filtered));
}

// Process-local cache of runtime version overrides. Reloaded periodically
// so a bump from the admin GUI takes effect within OVERRIDE_TTL_MS without
// requiring a redeploy. Skip cache entirely for the first call (so a fresh
// boot picks up existing overrides immediately).
const OVERRIDE_TTL_MS = 5_000;
let overridesCache: { suffixes: Record<string, string>; expiresAt: number } | null = null;

async function loadOverrides(): Promise<Record<string, string>> {
  if (overridesCache && Date.now() < overridesCache.expiresAt) {
    return overridesCache.suffixes;
  }
  try {
    const pool = await getPool();
    const r = await pool.query<{ tool: string; suffix: string }>(
      `SELECT tool, suffix FROM content_gen_tool_version_overrides`,
    );
    const suffixes: Record<string, string> = {};
    for (const row of r.rows) suffixes[row.tool] = row.suffix;
    overridesCache = { suffixes, expiresAt: Date.now() + OVERRIDE_TTL_MS };
    return suffixes;
  } catch {
    // First-boot table-missing or transient — return empty map; caller
    // falls back to static version. Don't poison the cache on error.
    return overridesCache?.suffixes ?? {};
  }
}

/** Force-refresh the override cache. Called from the cache API's
 *  bump_version action so the change takes effect on the next gem. */
export function invalidateOverridesCache(): void {
  overridesCache = null;
}

export async function computeCacheHash(tool: string, args: Record<string, unknown>): Promise<{ version: string; hash: string }> {
  const spec = TOOLS_BY_NAME[tool];
  const staticVersion = spec?.version ?? 'v0';
  const overrides = await loadOverrides();
  const suffix = overrides[tool];
  const version = suffix ? `${staticVersion}:${suffix}` : staticVersion;
  const argsKey = argsToCacheKey(tool, args);
  const hash = crypto.createHash('sha256')
    .update(tool, 'utf8')
    .update(':', 'utf8')
    .update(version, 'utf8')
    .update(':', 'utf8')
    .update(argsKey, 'utf8')
    .digest('hex');
  return { version, hash };
}

async function fileExists(p: string): Promise<boolean> {
  try { await fs.access(p); return true; } catch { return false; }
}

/** Look up a cached output for (tool, args). Returns null on miss OR
 *  when the cached entry references a file that has since been deleted. */
export async function lookupCache(
  tool: string,
  args: Record<string, unknown>,
): Promise<CachedToolOutput | null> {
  const { hash } = await computeCacheHash(tool, args);
  const pool = await getPool();
  const r = await pool.query<{
    id: number;
    output_jsonb: Record<string, unknown>;
    asset_paths: string[] | null;
    created_at: Date;
    hit_count: number;
  }>(
    `SELECT id, output_jsonb, asset_paths, created_at, hit_count
       FROM content_gen_tool_cache WHERE args_hash = $1`,
    [hash],
  );
  if (r.rows.length === 0) return null;
  const row = r.rows[0];

  // Verify every referenced asset still exists. If any are missing, treat
  // as cold-cache (delete the row) — saves us from serving stale URLs.
  const paths = row.asset_paths ?? [];
  for (const p of paths) {
    if (!(await fileExists(p))) {
      await pool.query(`DELETE FROM content_gen_tool_cache WHERE id = $1`, [row.id]).catch(() => {});
      return null;
    }
  }

  await pool.query(
    `UPDATE content_gen_tool_cache SET hit_count = hit_count + 1, last_used_at = NOW() WHERE id = $1`,
    [row.id],
  ).catch(() => {});

  return {
    output: row.output_jsonb,
    asset_paths: paths,
    origin: { row_id: row.id, created_at: row.created_at, hit_count: row.hit_count + 1 },
  };
}

/** Persist a successful tool output. Idempotent — UPSERT on args_hash. */
export async function storeCache(
  tool: string,
  args: Record<string, unknown>,
  output: Record<string, unknown>,
  assetPaths: string[],
): Promise<void> {
  const { version, hash } = await computeCacheHash(tool, args);
  const pool = await getPool();
  await pool.query(
    `INSERT INTO content_gen_tool_cache (tool, version, args_hash, output_jsonb, asset_paths, created_at, last_used_at, hit_count)
     VALUES ($1, $2, $3, $4::jsonb, $5, NOW(), NOW(), 0)
     ON CONFLICT (args_hash) DO UPDATE
       SET output_jsonb = EXCLUDED.output_jsonb,
           asset_paths  = EXCLUDED.asset_paths,
           version      = EXCLUDED.version,
           last_used_at = NOW()`,
    [tool, version, hash, JSON.stringify(output), assetPaths],
  ).catch(e => {
    // Swallow — cache write failures should never break the render.
    console.warn(`[tool-cache] store failed for ${tool}: ${(e as Error).message.slice(0, 200)}`);
  });
}

/** Extract on-disk paths from a tool output. Mirrors the producer's
 *  understanding of which output fields point at assets. Currently:
 *    output.local_path                 — single file (TTS, SFX, image)
 *    output.local_paths                — array of files (rare)
 *  Returns the unique non-empty paths.  */
export function extractAssetPaths(output: Record<string, unknown> | null | undefined): string[] {
  if (!output) return [];
  const set = new Set<string>();
  const lp = output.local_path;
  if (typeof lp === 'string' && lp) set.add(lp);
  const lps = output.local_paths;
  if (Array.isArray(lps)) for (const p of lps) if (typeof p === 'string' && p) set.add(p);
  return Array.from(set);
}
