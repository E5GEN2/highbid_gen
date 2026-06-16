import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { buildFleetSnapshot, deployBatch } from '@/lib/agent-deploy';
import { createNiche, addSeedUrlToNiche, deriveLabel } from '@/lib/agent-niche';
import { getBurstState, maybeRevertBurst } from '@/lib/content-gen/seed-scheduler';

/**
 * On-demand SEED-mode burst — fire N extra niche-spy crawls from one or more
 * seed video URLs, outside the auto-scheduler, matching the loop's job
 * variables (loopNumber=14, maxSuggested=50).
 *
 * GET  /api/admin/agents/burst
 *   Current burst state: whether a burst is bumping the thread budget, what it
 *   reverts to, the burst niches, and when the TTL backstop expires.
 *
 * POST /api/admin/agents/burst
 *   Body: {
 *     seedUrls?: string[],          // one OR many seed video URLs
 *     seedUrl?:  string,            // single (convenience)
 *     threadsPerSeed?: number = 1,  // crawl threads per seed (1-5)
 *     loopNumber?: number = 14,     // crawl depth — defaults to the loop's 14
 *     maxSuggested?: number = 50,   // candidates per hop
 *     additive?: boolean = true,    // bump auto_seed_max_threads so the burst
 *                                   //   runs ON TOP of the auto loop, then
 *                                   //   auto-revert when the burst finishes
 *     ttlMinutes?: number = 90,     // safety: always revert the bump by then
 *     label?: string,               // niche label (single-seed convenience)
 *     nicheId?: string,             // reuse an existing niche instead of minting
 *   }
 *
 * Returns the deployed tasks + the exact job variables used + the new budget.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 60;

const NICHE_SPY_JOB_ID = '69a58c4277cb8e2b9f1dddc4';

async function getConfig(): Promise<Record<string, string>> {
  const pool = await getPool();
  const r = await pool.query('SELECT key, value FROM admin_config');
  const c: Record<string, string> = {};
  for (const row of r.rows) c[row.key] = row.value;
  return c;
}
function getToken(c: Record<string, string>): string {
  return c.xgodo_niche_spy_token || c.xgodo_api_token
    || process.env.XGODO_NICHE_SPY_TOKEN || process.env.XGODO_API_TOKEN || '';
}
async function setConfig(key: string, value: string): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO admin_config (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = $2`,
    [key, value],
  );
}

export async function GET(req: NextRequest) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  // Opportunistically revert if the burst's tasks have finished.
  const reverted = await maybeRevertBurst().catch(() => ({ reverted: false }));
  const state = await getBurstState();
  return NextResponse.json({ ok: true, burst: state, justReverted: reverted });
}

export async function POST(req: NextRequest) {
  if (!(await isAdmin(req))) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  const body = await req.json().catch(() => ({}));
  const seedUrls: string[] = (Array.isArray(body.seedUrls) ? body.seedUrls : [])
    .concat(body.seedUrl ? [body.seedUrl] : [])
    .map((s: unknown) => String(s || '').trim())
    .filter((s: string) => /youtu/.test(s));
  if (seedUrls.length === 0) {
    return NextResponse.json({ error: 'provide seedUrl or seedUrls[] (YouTube URLs)' }, { status: 400 });
  }
  if (seedUrls.length > 20) {
    return NextResponse.json({ error: 'max 20 seeds per burst' }, { status: 400 });
  }

  const threadsPerSeed = Math.min(Math.max(parseInt(String(body.threadsPerSeed ?? 1)) || 1, 1), 5);
  const loopNumber = parseInt(String(body.loopNumber ?? 14)) || 14;
  const maxSuggested = parseInt(String(body.maxSuggested ?? 50)) || 50;
  const additive = body.additive !== false; // default true
  const ttlMinutes = Math.min(Math.max(parseInt(String(body.ttlMinutes ?? 90)) || 90, 10), 360);

  const config = await getConfig();
  const token = getToken(config);
  if (!token) return NextResponse.json({ error: 'xgodo token not configured' }, { status: 500 });

  const snapshot = await buildFleetSnapshot(token, NICHE_SPY_JOB_ID);
  const jobVariables = {
    loopNumber,
    maxSuggestedResultsBeforeFallback: maxSuggested,
  };

  const deployed: Array<{ seedUrl: string; nicheId: string; label: string; threads: number; errors: string[] }> = [];
  for (const seedUrl of seedUrls) {
    // Reuse an explicit nicheId only when a single seed is given; otherwise
    // mint one per seed (distinct niches → distinct crawls).
    let nicheId: string;
    let label: string;
    if (body.nicheId && seedUrls.length === 1) {
      nicheId = String(body.nicheId);
      label = body.label || nicheId;
    } else {
      label = (body.label && seedUrls.length === 1)
        ? String(body.label)
        : deriveLabel({ title: null, seedUrl });
      nicheId = await createNiche({ label, seedUrl, createdFrom: 'manual_burst' });
    }

    const taskInput = JSON.stringify({
      seedUrl,
      apiKey: config.agent_api_key || '',
      loopNumber,
      maxSuggestedResultsBeforeFallback: maxSuggested,
      rofeAPIKey: config.agent_rofe_api_key || '',
      nicheId,
    });

    const dep = await deployBatch(
      token, NICHE_SPY_JOB_ID,
      { keyword: nicheId, threads: threadsPerSeed, taskInput },
      snapshot,
    );
    await addSeedUrlToNiche(nicheId, seedUrl).catch(() => {});
    deployed.push({ seedUrl, nicheId, label, threads: dep.pinned + dep.unpinned, errors: dep.errors });
  }

  const totalThreads = deployed.reduce((n, d) => n + d.threads, 0);

  // ── Additive bump + revert bookkeeping ────────────────────────────────────
  // Bump AFTER deploying so the auto-scheduler never sees a raised budget
  // before the burst tasks register as in-flight (which would let it
  // over-dispatch). revert_to is the ORIGINAL budget (preserved across
  // back-to-back bursts). A TTL backstop guarantees the bump always reverts.
  let maxThreadsNow = parseInt(config.auto_seed_max_threads) || 10;
  if (additive && totalThreads > 0) {
    const prior = await getBurstState();
    const revertTo = prior.active ? prior.revertTo : maxThreadsNow;
    maxThreadsNow = maxThreadsNow + totalThreads;
    const niches = [...(prior.active ? prior.niches : []), ...deployed.map(d => d.nicheId)];
    const expiresAt = Date.now() + ttlMinutes * 60_000;
    await setConfig('auto_seed_max_threads', String(maxThreadsNow));
    await setConfig('auto_seed_burst_active', 'true');
    await setConfig('auto_seed_burst_revert_to', String(revertTo));
    await setConfig('auto_seed_burst_niches', JSON.stringify(niches));
    await setConfig('auto_seed_burst_expires_at', String(expiresAt));
  }

  return NextResponse.json({
    ok: true,
    deployed,
    totalThreads,
    jobVariables,
    additive,
    maxThreadsNow,
    note: additive
      ? `auto_seed_max_threads bumped to ${maxThreadsNow}; auto-reverts when these burst niches finish (or in ${ttlMinutes}m).`
      : 'non-additive: these share the existing seed budget (auto loop pauses until they drain).',
  });
}
