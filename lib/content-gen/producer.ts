/**
 * Producer — executes a ConcreteScript end-to-end and renders the final mp4.
 *
 * Pipeline:
 *   1. Persist job row + per-gem rows in content_gen_producer_{jobs,gems}
 *   2. For each slot, run all gems in PARALLEL — they're declared independent
 *      by the schema (no gem inside a slot can reference another gem's output
 *      at gem-args time; only compose.* fields use {{refs}}).
 *      Slots themselves run in parallel too — but capped to MAX_SLOT_CONC to
 *      keep the xgodo proxy / xgodo key pool from getting hammered.
 *   3. After every gem of every slot resolves, build a "bag" of outputs keyed
 *      by `slot_id.gem_id.field`. resolveRef() in concrete-script.ts walks it.
 *   4. Resolve compose.hold_s for each slot from the bag (`{{narr.duration_s}}`).
 *   5. Call video_compose with the ordered slot list + resolved bag → mp4.
 *   6. Update job row with final_video_url, status='done'.
 *
 * Error model:
 *   - A gem that fails marks itself status='failed' with error message.
 *     Other gems continue (best-effort). The slot is still "complete" if its
 *     critical gems (main visual + narr) succeeded; sfx is best-effort.
 *   - If the critical gems on any slot fail, the job goes status='failed'.
 *   - video_compose run is gated on no critical failures.
 *
 * Concurrency:
 *   - MAX_SLOT_CONC slots in flight at once (default 3) to bound xgodo load.
 *   - Within a slot, all gems fan out together — usually 2-4 gems so cheap.
 */

import { getPool } from '../db';
import { resolveRef, type ConcreteScript } from './concrete-script';
import { TOOLS_BY_NAME } from './tools';
import { runTool } from './producer-tools';

const MAX_SLOT_CONC = 3;
/** "main visual" + narration are required for a slot to be usable; sfx is
 *  best-effort. If you change this, also update the producer's slot-failure
 *  check. */
const CRITICAL_GEM_IDS = new Set(['narr', 'main']);

export interface ProducerJob {
  id: number;
  status: 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
  final_video_url: string | null;
  gems_total: number;
  gems_done: number;
  gems_failed: number;
}

export interface ProducerStartInput {
  script: ConcreteScript;
}

/** Insert the job + every gem row in 'pending' state. Returns the job id. */
export async function startJob(input: ProducerStartInput): Promise<number> {
  const pool = await getPool();
  const script = input.script;
  const ctx = script.context;

  const r = await pool.query<{ id: number }>(
    `INSERT INTO content_gen_producer_jobs
       (channel_id, channel_name, niche_index, video_id, status, script_jsonb, gems_total, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 'pending', $5::jsonb, $6, NOW(), NOW())
     RETURNING id`,
    [
      ctx.channelId ?? null,
      ctx.channel_name ?? null,
      ctx.niche_index ?? null,
      ctx.video_id ?? null,
      JSON.stringify(script),
      script.slots.reduce((a, s) => a + s.gems.length, 0),
    ],
  );
  const jobId = r.rows[0].id;

  // Insert per-gem rows. Simple per-row insert in a single SQL roundtrip
  // each — at ~60 rows max for a full video this is sub-second total.
  for (let slot_index = 0; slot_index < script.slots.length; slot_index++) {
    const slot = script.slots[slot_index];
    for (const g of slot.gems) {
      await pool.query(
        `INSERT INTO content_gen_producer_gems
           (job_id, slot_id, slot_index, gem_id, tool, args_jsonb)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [jobId, slot.slot_id, slot_index, g.id, g.tool, JSON.stringify(g.args)],
      );
    }
  }
  return jobId;
}

/** Mark a gem started, then run its tool, then persist the result.
 *
 *  Tool cache: before invoking the tool, look up (tool, version, args)
 *  in content_gen_tool_cache. On hit, write the cached output to the
 *  gem row + mark cache_hit=true, skip the tool call entirely. Saves
 *  the cost of yt_capture / TTS / image_gen / composer runs across
 *  re-renders with the same inputs. Bump TOOL_REGISTRY entry's
 *  `version` to invalidate. */
async function runOneGem(jobId: number, slot_id: string, gem_id: string, tool: string, args: Record<string, unknown>): Promise<{ ok: boolean; output?: Record<string, unknown>; error?: string; cached?: boolean }> {
  const pool = await getPool();
  const t0 = Date.now();
  await pool.query(
    `UPDATE content_gen_producer_gems
        SET status='running', started_at=NOW()
      WHERE job_id=$1 AND slot_id=$2 AND gem_id=$3`,
    [jobId, slot_id, gem_id],
  );

  // Execution-graph node for this gem — mark running so the live UI
  // can show in-flight state. Errors here never affect the gem run.
  const { upsertNode, nodeKey } = await import('./exec-graph');
  const gKey = nodeKey.gem(slot_id, gem_id);
  await upsertNode({
    jobId, nodeKey: gKey, nodeType: 'gem',
    label: `${tool} · ${gem_id}`, status: 'running',
    payload: { tool, slot_id, gem_id, args_summary: summarizeArgs(args) },
  });

  // Cache lookup (skipped if tool exports no version OR if args contains
  // force=true — caller is explicitly asking for a fresh run).
  const { lookupCache, storeCache, extractAssetPaths } = await import('./tool-cache');
  const wantsForce = args.force === true;
  if (!wantsForce) {
    const cached = await lookupCache(tool, args);
    if (cached) {
      const elapsed = Date.now() - t0;
      await pool.query(
        `UPDATE content_gen_producer_gems
            SET status='done', output_jsonb=$1::jsonb, elapsed_ms=$2,
                finished_at=NOW(), cache_hit=TRUE, cache_row_id=$3
          WHERE job_id=$4 AND slot_id=$5 AND gem_id=$6`,
        [JSON.stringify(cached.output), elapsed, cached.origin.row_id, jobId, slot_id, gem_id],
      );
      await upsertNode({
        jobId, nodeKey: gKey, nodeType: 'gem',
        label: `${tool} · ${gem_id}`, status: 'cached',
        payload: { tool, cached_from_row: cached.origin.row_id, elapsed_ms: elapsed,
                   hit_count: cached.origin.hit_count, asset_paths: cached.asset_paths },
      });
      return { ok: true, output: cached.output, cached: true };
    }
  }

  try {
    const out = await runTool(tool, args);
    const elapsed = Date.now() - t0;
    await pool.query(
      `UPDATE content_gen_producer_gems
          SET status='done', output_jsonb=$1::jsonb, elapsed_ms=$2, finished_at=NOW()
        WHERE job_id=$3 AND slot_id=$4 AND gem_id=$5`,
      [JSON.stringify(out), elapsed, jobId, slot_id, gem_id],
    );
    const assetPaths = extractAssetPaths(out);
    await upsertNode({
      jobId, nodeKey: gKey, nodeType: 'gem',
      label: `${tool} · ${gem_id}`, status: 'done',
      payload: { tool, elapsed_ms: elapsed, asset_paths: assetPaths,
                 file_url: (out as Record<string, unknown>).file_url ?? null },
    });
    // Persist to the cache for future renders. Only cache successful
    // outputs; skip silently on store errors (cache misses are cheaper
    // than cache write failures bubbling up).
    void storeCache(tool, args, out, assetPaths);
    return { ok: true, output: out };
  } catch (e) {
    const elapsed = Date.now() - t0;
    const msg = (e as Error).message.slice(0, 800);
    await pool.query(
      `UPDATE content_gen_producer_gems
          SET status='failed', error=$1, elapsed_ms=$2, finished_at=NOW()
        WHERE job_id=$3 AND slot_id=$4 AND gem_id=$5`,
      [msg, elapsed, jobId, slot_id, gem_id],
    );
    await upsertNode({
      jobId, nodeKey: gKey, nodeType: 'gem',
      label: `${tool} · ${gem_id}`, status: 'failed',
      payload: { tool, elapsed_ms: elapsed, error: msg },
    });
    return { ok: false, error: msg };
  }
}

/** Summarize gem args for the execution graph payload — keeps long
 *  fields (text, urls, etc.) short so the GUI panel doesn't blow up. */
function summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(args)) {
    const v = args[k];
    if (typeof v === 'string' && v.length > 80) out[k] = v.slice(0, 77) + '…';
    else if (Array.isArray(v) && v.length > 6) out[k] = `[${v.length} items]`;
    else out[k] = v;
  }
  return out;
}

/** Run every gem of every slot, then resolve compose refs, then call
 *  video_compose. Returns the final mp4 url on success. */
export async function runJob(jobId: number): Promise<{ ok: boolean; final_video_url?: string; error?: string }> {
  const pool = await getPool();

  // Load the script back from the DB (so retries don't need the input passed).
  const r = await pool.query<{ script_jsonb: ConcreteScript }>(
    `SELECT script_jsonb FROM content_gen_producer_jobs WHERE id = $1`,
    [jobId],
  );
  if (r.rows.length === 0) throw new Error(`producer job ${jobId} not found`);
  const script = r.rows[0].script_jsonb;

  await pool.query(
    `UPDATE content_gen_producer_jobs SET status='running', started_at=NOW(), updated_at=NOW() WHERE id=$1`,
    [jobId],
  );

  // bag[slot_id][gem_id] = output
  const bag: Record<string, Record<string, Record<string, unknown>>> = {};
  // Track which slots had a critical gem fail
  const slotCritFail: Record<string, string> = {};

  // Slot worker — runs all gems for one slot in parallel. Also drives
  // the execution-graph slot node (lifecycle: running → done|failed)
  // and the slot→gem edges so the UI can group gems under their slot.
  const { upsertNode, addEdge, nodeKey } = await import('./exec-graph');
  async function runSlot(slot: ConcreteScript['slots'][number]): Promise<void> {
    const sKey = nodeKey.slot(slot.slot_id);
    await upsertNode({
      jobId, nodeKey: sKey, nodeType: 'slot',
      label: slot.slot_id, status: 'running',
      payload: { beat_id: slot.beat_id, gem_count: slot.gems.length, narration: slot.narration?.slice(0, 80) },
    });
    // Pre-emit slot→gem edges so the UI sees the structure even before
    // a gem starts running.
    for (const g of slot.gems) {
      await addEdge(jobId, sKey, nodeKey.gem(slot.slot_id, g.id), 'depends_on');
    }

    const results = await Promise.all(slot.gems.map(g =>
      runOneGem(jobId, slot.slot_id, g.id, g.tool, g.args).then(res => ({ gem_id: g.id, res }))
    ));
    bag[slot.slot_id] = {};
    let anyFailed = false;
    for (const { gem_id, res } of results) {
      if (res.ok && res.output) {
        bag[slot.slot_id][gem_id] = res.output;
      } else if (CRITICAL_GEM_IDS.has(gem_id)) {
        slotCritFail[slot.slot_id] = `gem "${gem_id}" failed: ${res.error}`;
        anyFailed = true;
      } else if (!res.ok) {
        anyFailed = true;
      }
    }
    await upsertNode({
      jobId, nodeKey: sKey, nodeType: 'slot',
      label: slot.slot_id,
      status: anyFailed ? 'failed' : 'done',
      payload: {
        beat_id: slot.beat_id,
        gem_count: slot.gems.length,
        ok_count: results.filter(r => r.res.ok).length,
        cached_count: results.filter(r => r.res.cached).length,
      },
    });
  }

  // Fan out slots in batches of MAX_SLOT_CONC.
  for (let i = 0; i < script.slots.length; i += MAX_SLOT_CONC) {
    const batch = script.slots.slice(i, i + MAX_SLOT_CONC);
    await Promise.all(batch.map(runSlot));
    // Refresh aggregate counts so the GUI can show progress.
    await pool.query(
      `UPDATE content_gen_producer_jobs
          SET gems_done = (SELECT COUNT(*) FROM content_gen_producer_gems WHERE job_id=$1 AND status='done'),
              gems_failed = (SELECT COUNT(*) FROM content_gen_producer_gems WHERE job_id=$1 AND status='failed'),
              updated_at = NOW()
        WHERE id=$1`,
      [jobId],
    );
  }

  // If any critical gem failed, fail the whole job — don't try to compose.
  const critFailCount = Object.keys(slotCritFail).length;
  if (critFailCount > 0) {
    const msg = `critical gems failed on ${critFailCount} slot(s): ` +
      Object.entries(slotCritFail).slice(0, 3).map(([s, e]) => `${s}: ${e}`).join('; ');
    await pool.query(
      `UPDATE content_gen_producer_jobs SET status='failed', error=$1, finished_at=NOW(), updated_at=NOW() WHERE id=$2`,
      [msg.slice(0, 800), jobId],
    );
    return { ok: false, error: msg };
  }

  // Resolve compose refs for each slot — surface them into the bag so
  // video_compose can read resolved hold_s + layer urls.
  for (const slot of script.slots) {
    const composeResolved: Record<string, unknown> = { bg: slot.compose.bg, layers: [] as unknown[] };
    composeResolved.hold_s = typeof slot.compose.hold_s === 'number'
      ? slot.compose.hold_s
      : resolveRef(slot.compose.hold_s, bag as unknown as Record<string, unknown>, slot.slot_id) ?? 2.0;
    composeResolved.layers = slot.compose.layers.map(l => {
      // l.from is a local gem id like "main" — look up in bag
      const localOutput = bag[slot.slot_id]?.[l.from];
      // Pull capture_id from yt_capture file_url so video-compose can fetch
      // bboxes_jsonb without re-parsing the URL.
      const file_url = (localOutput && (localOutput.file_url as string)) ?? null;
      const capture_id = file_url
        ? (file_url.match(/[?&]id=(\d+)/)?.[1] ? parseInt(file_url.match(/[?&]id=(\d+)/)![1], 10) : null)
        : null;
      return {
        ...l,
        url: file_url,
        duration_s: (localOutput && (localOutput.duration_s as number)) ?? null,
        local_path: (localOutput && (localOutput.local_path as string)) ?? null,
        capture_id,
      };
    });
    bag[slot.slot_id].__compose__ = composeResolved;
  }

  // Final assembly. video_compose is a real tool registered in the registry
  // but its dispatcher (producer-tools.ts) reads the bag + slot order directly.
  if (!TOOLS_BY_NAME.video_compose) {
    throw new Error('video_compose tool not registered');
  }
  // Compose node — every slot feeds into this (compose_input edges).
  const composeKey = nodeKey.compose(jobId);
  await upsertNode({
    jobId, nodeKey: composeKey, nodeType: 'compose',
    label: `video_compose · ${script.slots.length} slots`, status: 'running',
    payload: { slot_count: script.slots.length },
  });
  for (const s of script.slots) {
    await addEdge(jobId, nodeKey.slot(s.slot_id), composeKey, 'compose_input');
  }

  let final_video_url: string | undefined;
  try {
    // Long-form 16:9 (MG long-form per worked-example, NOT Shorts). The
    // script writer's training data leans toward 1080×1920 — coerce here
    // so the final mp4 is always horizontal regardless of what the writer
    // emitted. To opt into portrait, set finalArgs.aspect='portrait' (TBD).
    const writerW = script.final.args.width as number | undefined;
    const writerH = script.final.args.height as number | undefined;
    const wantsPortrait = writerW && writerH && writerH > writerW; // ignore the writer's portrait inertia
    const composeOut = await runTool('video_compose', {
      slot_order: script.slots.map(s => s.slot_id),
      width:  wantsPortrait ? 1920 : (writerW ?? 1920),
      height: wantsPortrait ? 1080 : (writerH ?? 1080),
      fps: (script.final.args.fps as number) ?? 30,
      default_bg: (script.final.args.default_bg as string) ?? 'dark_gray',
      // Pass the resolved bag — producer-tools.video_compose consumes it
      __bag__: bag,
      __job_id__: jobId,
    });
    final_video_url = composeOut.file_url as string;
    await upsertNode({
      jobId, nodeKey: composeKey, nodeType: 'compose',
      label: `video_compose · ${script.slots.length} slots`, status: 'done',
      payload: { final_video_url, duration_s: composeOut.duration_s },
    });
  } catch (e) {
    const msg = (e as Error).message.slice(0, 800);
    await pool.query(
      `UPDATE content_gen_producer_jobs SET status='failed', error=$1, finished_at=NOW(), updated_at=NOW() WHERE id=$2`,
      [`compose failed: ${msg}`, jobId],
    );
    await upsertNode({
      jobId, nodeKey: composeKey, nodeType: 'compose',
      label: `video_compose · ${script.slots.length} slots`, status: 'failed',
      payload: { error: msg },
    });
    return { ok: false, error: msg };
  }

  await pool.query(
    `UPDATE content_gen_producer_jobs
        SET status='done', final_video_url=$1, finished_at=NOW(), updated_at=NOW()
      WHERE id=$2`,
    [final_video_url, jobId],
  );
  return { ok: true, final_video_url };
}

/** Fetch a job's current state for the API/GUI. */
export async function getJobStatus(jobId: number): Promise<{
  job: Record<string, unknown> | null;
  gems: Array<Record<string, unknown>>;
}> {
  const pool = await getPool();
  const j = await pool.query(
    `SELECT id, channel_id, channel_name, niche_index, video_id, status,
            final_video_url, gems_total, gems_done, gems_failed, error,
            started_at, finished_at, created_at, updated_at
       FROM content_gen_producer_jobs WHERE id=$1`,
    [jobId],
  );
  if (j.rows.length === 0) return { job: null, gems: [] };
  const g = await pool.query(
    `SELECT slot_id, slot_index, gem_id, tool, status, output_jsonb, error,
            elapsed_ms, started_at, finished_at, args_jsonb
       FROM content_gen_producer_gems WHERE job_id=$1
       ORDER BY slot_index ASC, gem_id ASC`,
    [jobId],
  );
  return { job: j.rows[0], gems: g.rows };
}
