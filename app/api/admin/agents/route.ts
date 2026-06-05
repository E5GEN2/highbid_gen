import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';
import { fetchRunningTasks, fetchPlannedTasks, countInFlight } from '@/lib/xgodo-tasks';
import { buildFleetSnapshot, deployBatch } from '@/lib/agent-deploy';
import { createNiche, getNiche, addSeedUrlToNiche, getNicheLabels, deriveLabel } from '@/lib/agent-niche';

const NICHE_SPY_JOB_ID = '69a58c4277cb8e2b9f1dddc4';

async function getConfig(): Promise<Record<string, string>> {
  const pool = await getPool();
  const result = await pool.query('SELECT key, value FROM admin_config');
  const config: Record<string, string> = {};
  for (const row of result.rows) config[row.key] = row.value;
  return config;
}

function getToken(config: Record<string, string>): string {
  return config.xgodo_niche_spy_token || config.xgodo_api_token || process.env.XGODO_NICHE_SPY_TOKEN || process.env.XGODO_API_TOKEN || '';
}

/**
 * GET /api/admin/agents
 * Fetch active (running) xgodo tasks, grouped by keyword.
 */
export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  try {
    const pool = await getPool();
    const config = await getConfig();
    const token = getToken(config);
    if (!token) return NextResponse.json({ error: 'xgodo token not configured' }, { status: 500 });

    // Fetch running + planned in parallel so the UI sees the same in-flight
    // numbers the thermostat uses to make decisions.
    const [running, planned] = await Promise.all([
      fetchRunningTasks(token, NICHE_SPY_JOB_ID),
      fetchPlannedTasks(token, NICHE_SPY_JOB_ID),
    ]);

    const inflight = countInFlight(running, planned);

    // Per work-unit-key metadata: kind (keyword|seed) + the seed URLs
    // running under it. A group is 'seed' if any of its tasks is a seed.
    const keyMeta = new Map<string, { kind: 'keyword' | 'seed' | 'unknown'; seedUrls: Set<string> }>();
    for (const t of [...running, ...planned]) {
      const m = keyMeta.get(t.keyword) ?? { kind: 'unknown' as const, seedUrls: new Set<string>() };
      if (t.kind === 'seed') m.kind = 'seed';
      else if (m.kind !== 'seed' && t.kind === 'keyword') m.kind = 'keyword';
      if (t.seedUrl) m.seedUrls.add(t.seedUrl);
      keyMeta.set(t.keyword, m);
    }
    // Resolve human labels for seed niches.
    const seedKeys = [...keyMeta.entries()].filter(([, m]) => m.kind === 'seed').map(([k]) => k);
    const nicheLabels = await getNicheLabels(seedKeys);

    // Build grouped view — running + planned per work-unit, sorted by in-flight
    const byKeyword = Object.entries(inflight)
      .map(([keyword, rec]) => {
        const meta = keyMeta.get(keyword);
        const kind = meta?.kind ?? 'keyword';
        const niche = kind === 'seed' ? nicheLabels.get(keyword) : null;
        return {
          keyword,                                   // the work-unit key
          kind,
          label: niche?.label ?? keyword,            // human display name
          seedUrls: meta ? [...meta.seedUrls] : [],
          active: rec.running,    // kept for backward compat with the UI
          running: rec.running,
          planned: rec.planned,
          inFlight: rec.inFlight,
          taskIds: running.filter(r => r.keyword === keyword).map(r => r.taskId),
        };
      })
      .sort((a, b) => b.inFlight - a.inFlight);

    // Fetch duration data for running tasks from task log
    const taskIds = running.map(r => r.taskId).filter(Boolean);
    const durationMap: Record<string, { firstSeen: string; duration: number }> = {};
    if (taskIds.length > 0) {
      const logRes = await pool.query(
        "SELECT task_id, first_seen_at, EXTRACT(EPOCH FROM (NOW() - first_seen_at))::integer as duration_sec FROM agent_task_log WHERE task_id = ANY($1)",
        [taskIds]
      );
      for (const r of logRes.rows) {
        durationMap[r.task_id] = { firstSeen: r.first_seen_at, duration: r.duration_sec };
      }
    }

    // Also fetch recently completed tasks (last 1 hour)
    const recentRes = await pool.query(
      "SELECT task_id, keyword, first_seen_at, last_seen_at, status, worker_name, EXTRACT(EPOCH FROM (last_seen_at - first_seen_at))::integer as duration_sec FROM agent_task_log WHERE status = 'completed' AND last_seen_at > NOW() - INTERVAL '1 hour' ORDER BY last_seen_at DESC LIMIT 50"
    );

    return NextResponse.json({
      totalActive: running.length,         // backward compat
      totalRunning: running.length,
      totalPlanned: planned.length,
      totalInFlight: running.length + planned.length,
      byKeyword,
      tasks: running.map(r => ({
        id: r.taskId,
        keyword: r.keyword,
        startedAt: r.startedAt,
        workerName: r.workerName,
        duration: durationMap[r.taskId]?.duration || null,
        firstSeen: durationMap[r.taskId]?.firstSeen || null,
      })),
      plannedTasks: planned.map(p => ({
        id: p.plannedTaskId,
        keyword: p.keyword,
        added: p.added,
      })),
      recentCompleted: recentRes.rows.map(r => ({
        id: r.task_id,
        keyword: r.keyword,
        duration: r.duration_sec,
        completedAt: r.last_seen_at,
        workerName: r.worker_name,
      })),
    });
  } catch (err) {
    console.error('[agents] Monitor error:', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

/**
 * POST /api/admin/agents
 * Deploy new agent threads. Two modes:
 *
 *   KEYWORD (legacy):
 *     Body: { keyword, threads, apiKey, loopNumber,
 *             maxSearchResultsBeforeFallback, maxSuggestedResultsBeforeFallback,
 *             rofeAPIKey }
 *     xgodo task input: { keyword, apiKey, loopNumber,
 *                         maxSearchResultsBeforeFallback,
 *                         maxSuggestedResultsBeforeFallback, rofeAPIKey }
 *
 *   SEED (video-URL niche discovery):
 *     Body: { mode:'seed', seedUrl, threads, apiKey, loopNumber,
 *             maxSuggestedResultsBeforeFallback, rofeAPIKey,
 *             nicheId?, label?, seedTitle?, createdFrom? }
 *     - nicheId: reuse an existing niche, or omit to mint a new one.
 *     - label / seedTitle: human name for a freshly-minted niche.
 *     xgodo task input: { seedUrl, apiKey, loopNumber,
 *                         maxSuggestedResultsBeforeFallback, rofeAPIKey, nicheId }
 *
 * Seed tasks group by nicheId (the work-unit key) everywhere downstream —
 * monitor, pins, logs — exactly the way keyword tasks group by keyword.
 */
export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });

  try {
    const body = await req.json();
    const threads: number = body.threads ?? 1;
    if (threads < 1 || threads > 20) return NextResponse.json({ error: 'threads must be 1-20' }, { status: 400 });

    const config = await getConfig();
    const token = getToken(config);
    if (!token) return NextResponse.json({ error: 'xgodo token not configured' }, { status: 500 });

    const isSeed = body.mode === 'seed' || (!body.keyword && typeof body.seedUrl === 'string');

    let workKey: string;       // grouping/pin key → keyword OR nicheId
    let taskInput: Record<string, unknown>;
    let respExtra: Record<string, unknown>;

    if (isSeed) {
      // ── SEED MODE ──────────────────────────────────────────────────
      const seedUrl: string = (body.seedUrl || '').trim();
      if (!seedUrl) return NextResponse.json({ error: 'seedUrl required for seed mode' }, { status: 400 });

      // Resolve nicheId: reuse if provided + known, else mint a new niche.
      let nicheId: string;
      if (body.nicheId) {
        const existing = await getNiche(body.nicheId);
        if (!existing) return NextResponse.json({ error: `unknown nicheId ${body.nicheId}` }, { status: 400 });
        nicheId = existing.niche_id;
        await addSeedUrlToNiche(nicheId, seedUrl);
      } else {
        const label = (body.label || deriveLabel({ title: body.seedTitle, seedUrl })).toString();
        nicheId = await createNiche({ label, seedUrl, createdFrom: body.createdFrom || 'manual' });
      }

      taskInput = {
        seedUrl,
        apiKey: body.apiKey || config.agent_api_key || '',
        loopNumber: body.loopNumber ?? 30,
        maxSuggestedResultsBeforeFallback: body.maxSuggestedResultsBeforeFallback ?? 50,
        rofeAPIKey: body.rofeAPIKey || config.agent_rofe_api_key || '',
        nicheId,
      };
      workKey = nicheId;
      respExtra = { mode: 'seed', nicheId, seedUrl };
    } else {
      // ── KEYWORD MODE (legacy, unchanged) ───────────────────────────
      const keyword: string = body.keyword;
      if (!keyword) return NextResponse.json({ error: 'keyword required' }, { status: 400 });
      taskInput = {
        keyword,
        apiKey: body.apiKey || config.agent_api_key || '',
        loopNumber: body.loopNumber ?? 30,
        maxSearchResultsBeforeFallback: body.maxSearchResultsBeforeFallback ?? 50,
        maxSuggestedResultsBeforeFallback: body.maxSuggestedResultsBeforeFallback ?? 50,
        rofeAPIKey: body.rofeAPIKey || config.agent_rofe_api_key || '',
      };
      workKey = keyword;
      respExtra = { mode: 'keyword', keyword };
    }

    const inputStr = JSON.stringify(taskInput);

    // Warm-device pinning keys on workKey — for seeds that's the nicheId,
    // matched against whatever the bot writes to its xgodo bucket. If no
    // warm match (e.g. brand-new niche), every task goes unpinned. Same
    // graceful fallback the keyword path already relies on.
    const snapshot = await buildFleetSnapshot(token, NICHE_SPY_JOB_ID);
    const dep = await deployBatch(
      token, NICHE_SPY_JOB_ID,
      { keyword: workKey, threads, taskInput: inputStr },
      snapshot,
    );

    const totalDeployed = dep.pinned + dep.unpinned;
    if (totalDeployed === 0 && dep.errors.length > 0) {
      return NextResponse.json(
        { error: `xgodo submit failed: ${dep.errors.join(' | ')}` },
        { status: 502 },
      );
    }

    return NextResponse.json({
      ok: true,
      deployed: totalDeployed,
      pinned: dep.pinned,
      unpinned: dep.unpinned,
      pinnedDevices: dep.pinnedDevices,
      keyword: workKey,    // back-compat field (the work-unit key)
      partialErrors: dep.errors,
      ...respExtra,
    });
  } catch (err) {
    console.error('[agents] Deploy error:', err);
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
