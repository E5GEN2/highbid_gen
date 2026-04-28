/**
 * Shared planned-task deploy logic for the niche-spy scheduler.
 *
 * Used by both the thermostat (auto-replenish to target_threads) and the
 * manual /api/admin/agents POST (one-shot deploy). Centralised here so
 * the warm-device-pinning behaviour is identical.
 *
 * The smart bit: when the agent writes its current niche into its
 * job-bucket on each task start/finish, a device that's already
 * researched a niche has a primed Firefox profile (suggested videos,
 * watch history) for that niche. Re-running the same niche on the same
 * device skips the data-wipe and continues mid-research, which the user
 * has confirmed is meaningfully faster.
 *
 * Algorithm — per call:
 *   1. Read all job-buckets for the niche-spy job (one call, paginated)
 *   2. Read market devices online + payment_type='action' (one call)
 *   3. Read existing pins from DB (so we don't double-pin a device)
 *   4. Build the set of "warm devices" for each target keyword:
 *        bucket.niche == keyword  AND  device is online  AND  no pin yet
 *   5. For each task to deploy: pick a warm device if any, else submit
 *      unpinned (so xgodo can route freely)
 *   6. Record successful pins in agent_planned_pins for the next tick's
 *      "already taken" check + the zombie sweep.
 *
 * Failure modes handled:
 *   - bucket fetch fails → log + skip pinning, all tasks go unpinned
 *   - market fetch fails → same
 *   - submit fails per-task → counted in `errors`, others continue
 *
 * What this does NOT do:
 *   - tracks zombies (pinned tasks whose device went offline) — that's
 *     the thermostat's zombie sweep, in a separate function
 */

import { getPool } from './db';
import { listJobBuckets, type XgodoJobBucket } from './xgodo-buckets';
import { listMarketDevices, marketDeviceNameSet } from './xgodo-market-devices';

const XGODO_API = 'https://xgodo.com/api/v2';

/**
 * Bucket keys we accept for the niche field. Tried in order — first
 * non-empty wins. The agent currently writes `lastNiche` (verified by
 * inspecting live buckets — every device on 2026-04-27 had it set),
 * but we keep aliases so a future schema change doesn't immediately
 * break the scheduler.
 *
 * Live bucket shape, for reference:
 *   { lastNiche: "motivation", firefoxDataPreserved: false,
 *     updatedAt: "2026-04-27T13:36:15.012Z" }
 */
const BUCKET_NICHE_KEYS = [
  'lastNiche', 'last_niche',
  'niche', 'currentNiche', 'current_niche',
  'keyword', 'currentKeyword',
] as const;

function extractBucketNiche(data: Record<string, unknown> | null | undefined): string | null {
  if (!data) return null;
  for (const k of BUCKET_NICHE_KEYS) {
    const v = data[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/** Inputs for a single deploy call — one keyword, N threads to add. */
export interface DeployBatch {
  keyword: string;
  threads: number;        // how many new tasks to submit for this keyword
  taskInput: string;      // pre-built JSON string passed verbatim to xgodo
}

export interface DeployResult {
  keyword: string;
  requested: number;
  pinned: number;
  unpinned: number;
  pinnedDevices: string[];
  errors: string[];
}

/** Cached fleet snapshot — pass once to deployBatch when deploying many keywords in one tick. */
export interface FleetSnapshot {
  buckets: XgodoJobBucket[];
  /** lowercase niche → set of device_name */
  warmByNiche: Map<string, Set<string>>;
  /** device names currently online + on the market */
  onlineDevices: Set<string>;
  /** device names already pinned (any keyword) — don't double-pin */
  pinnedDevices: Set<string>;
  /**
   * device names currently running a task on this job. Excluded from
   * pin candidates because xgodo's run_immediately can't assign a new
   * task to a device that's already busy on the job — the planned task
   * just sits in xgodo's queue indefinitely. Pinning to a busy device
   * is exactly the failure mode that left target=3 keywords running 1
   * thread with 2 stuck planned, even though `assigned: false` came
   * back from xgodo at submit time.
   */
  busyDevices: Set<string>;
}

export async function buildFleetSnapshot(
  token: string,
  jobId: string,
): Promise<FleetSnapshot> {
  const pool = await getPool();

  // Fire all four reads in parallel — they're independent. The running
  // fetch needs device_name (which fetchRunningTasks doesn't surface),
  // so we hit /jobs/applicants directly here.
  const [bucketsRes, marketRes, pinsRes, runningRes] = await Promise.allSettled([
    listJobBuckets(token, jobId),
    listMarketDevices(token),
    pool.query<{ device_name: string }>(
      `SELECT device_name FROM agent_planned_pins WHERE job_id = $1`,
      [jobId],
    ),
    fetch(`${XGODO_API}/jobs/applicants`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: jobId, status: 'running', limit: 100 }),
    }).then(async r => {
      if (!r.ok) throw new Error(`xgodo running ${r.status}`);
      return r.json() as Promise<{ job_tasks?: Array<{ device_name?: string | null }> }>;
    }),
  ]);

  const buckets = bucketsRes.status === 'fulfilled' ? bucketsRes.value : [];
  const market  = marketRes.status  === 'fulfilled' ? marketRes.value  : [];
  const pinRows = pinsRes.status    === 'fulfilled' ? pinsRes.value.rows : [];
  const runBody = runningRes.status === 'fulfilled' ? runningRes.value : { job_tasks: [] };

  if (bucketsRes.status === 'rejected') {
    console.warn('[agent-deploy] bucket fetch failed — pinning disabled this tick:', (bucketsRes.reason as Error).message);
  }
  if (marketRes.status === 'rejected') {
    console.warn('[agent-deploy] market fetch failed — pinning disabled this tick:', (marketRes.reason as Error).message);
  }
  if (runningRes.status === 'rejected') {
    console.warn('[agent-deploy] running fetch failed — busy-device exclusion disabled this tick:', (runningRes.reason as Error).message);
  }

  const onlineDevices = marketDeviceNameSet(market);
  const pinnedDevices = new Set(pinRows.map(r => r.device_name));
  const busyDevices = new Set<string>();
  for (const t of runBody.job_tasks || []) {
    if (t.device_name) busyDevices.add(t.device_name);
  }

  const warmByNiche = new Map<string, Set<string>>();
  for (const b of buckets) {
    const niche = extractBucketNiche(b.data as Record<string, unknown>);
    if (!niche || !b.device_name) continue;
    const key = niche.toLowerCase();
    let set = warmByNiche.get(key);
    if (!set) { set = new Set(); warmByNiche.set(key, set); }
    set.add(b.device_name);
  }

  return { buckets, warmByNiche, onlineDevices, pinnedDevices, busyDevices };
}

/**
 * Submit `batch.threads` planned tasks for `batch.keyword`. Pinned to
 * warm + online + not-yet-taken devices first; remainder goes unpinned.
 * Mutates `snapshot.pinnedDevices` so subsequent batches in the same
 * tick can't reuse a device that this batch just claimed.
 */
export async function deployBatch(
  token: string,
  jobId: string,
  batch: DeployBatch,
  snapshot: FleetSnapshot,
): Promise<DeployResult> {
  const result: DeployResult = {
    keyword: batch.keyword,
    requested: batch.threads,
    pinned: 0,
    unpinned: 0,
    pinnedDevices: [],
    errors: [],
  };

  if (batch.threads <= 0) return result;

  // Pick warm devices: in our niche AND online AND not already pinned
  // AND not currently running another task on this job. The busy-device
  // filter is essential — pinning to a busy device leaves the planned
  // task waiting indefinitely (xgodo's run_immediately returns
  // assigned:false and there's no auto-pickup once the device frees).
  const warmSet = snapshot.warmByNiche.get(batch.keyword.toLowerCase());
  const candidates = warmSet
    ? [...warmSet].filter(name =>
        snapshot.onlineDevices.has(name) &&
        !snapshot.pinnedDevices.has(name) &&
        !snapshot.busyDevices.has(name)
      )
    : [];

  // Take up to `threads` warm candidates; submit one task per pin.
  const toPin = candidates.slice(0, batch.threads);
  for (const deviceName of toPin) {
    const ok = await submitOne(token, jobId, batch.taskInput, { device_name: deviceName, run_immediately: true });
    if (ok.ok) {
      // Persist the pin records we got back. xgodo can return multiple
      // inserted_ids per call but we only ever sent one input here.
      const pool = await getPool();
      for (const inserted of ok.insertedIds) {
        await pool.query(
          `INSERT INTO agent_planned_pins (planned_task_id, job_id, keyword, device_name)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (planned_task_id) DO NOTHING`,
          [inserted, jobId, batch.keyword, deviceName],
        ).catch(err => {
          console.warn('[agent-deploy] pin insert failed:', (err as Error).message);
        });
      }
      result.pinned++;
      result.pinnedDevices.push(deviceName);
      snapshot.pinnedDevices.add(deviceName); // claim for next batch in this tick
    } else {
      result.errors.push(`pin ${deviceName}: ${ok.error}`);
    }
  }

  // Whatever's left we submit in one batch unpinned — xgodo will route
  // these to any worker that fits. Cheaper than N separate calls.
  const unpinnedCount = batch.threads - result.pinned;
  if (unpinnedCount > 0) {
    const inputs = Array.from({ length: unpinnedCount }, () => batch.taskInput);
    const ok = await submitMany(token, jobId, inputs);
    if (ok.ok) {
      result.unpinned += unpinnedCount;
    } else {
      result.errors.push(`unpinned batch: ${ok.error}`);
    }
  }

  return result;
}

// Single shape (always includes both fields) — sidesteps TypeScript's
// reluctance to narrow discriminated unions through if/else assignment.
// Same pattern as ApplicantsResp in xgodo-vizard-upload.ts.
interface SubmitResp {
  ok: boolean;
  insertedIds: string[];
  error: string;
}

async function submitOne(
  token: string, jobId: string, input: string,
  extras: { device_name?: string; remote_device_id?: string; run_immediately?: boolean },
): Promise<SubmitResp> {
  return submitMany(token, jobId, [input], extras);
}

async function submitMany(
  token: string, jobId: string, inputs: string[],
  extras: { device_name?: string; remote_device_id?: string; run_immediately?: boolean } = {},
): Promise<SubmitResp> {
  if (inputs.length === 0) return { ok: true, insertedIds: [], error: '' };
  try {
    const body: Record<string, unknown> = { job_id: jobId, inputs };
    if (extras.remote_device_id) body.remote_device_id = extras.remote_device_id;
    else if (extras.device_name) body.device_name = extras.device_name;
    if (extras.run_immediately) body.run_immediately = true;

    const res = await fetch(`${XGODO_API}/planned_tasks/submit`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, insertedIds: [], error: `xgodo submit ${res.status}: ${text.slice(0, 200)}` };
    }
    const data = await res.json() as { inserted_ids?: Array<{ planned_task_id?: string; _id?: string }> };
    const ids = (data.inserted_ids || [])
      .map(i => i.planned_task_id || i._id || '')
      .filter(Boolean);
    return { ok: true, insertedIds: ids, error: '' };
  } catch (err) {
    return { ok: false, insertedIds: [], error: (err as Error).message };
  }
}

/**
 * Zombie sweep — call once per tick AFTER bucket/market are fetched.
 * For every pin record whose device is no longer online (left market),
 * delete the planned task from xgodo so the slot frees up. Also prune
 * pin records whose planned_task_id is no longer unassigned (= the
 * task got picked up by xgodo, or was deleted by something else).
 *
 * Inputs:
 *   livePlannedIds — set of currently-unassigned planned_task_ids in
 *                    xgodo (from fetchPlannedTasks). Used to detect
 *                    pins whose task got picked up.
 */
export async function sweepZombiePins(
  token: string,
  jobId: string,
  snapshot: FleetSnapshot,
  livePlannedIds: Set<string>,
): Promise<{ stale: number; zombieDeleted: number; errors: string[] }> {
  const pool = await getPool();
  const result = { stale: 0, zombieDeleted: 0, errors: [] as string[] };

  // The 60s grace window protects newly-inserted pin rows from being
  // stale-pruned in the same tick they were created. The sweep uses
  // `livePlannedIds` from the START of the tick (before deploys), so
  // pins inserted DURING this tick won't be in that set even though
  // their planned tasks just got created. Without this gate, every
  // pinned deploy got immediately wiped from agent_planned_pins,
  // leaving pinnedDevices empty for the next tick and causing us to
  // pin to busy devices repeatedly.
  const pinsRes = await pool.query<{ planned_task_id: string; device_name: string; created_at: Date }>(
    `SELECT planned_task_id, device_name, created_at
     FROM agent_planned_pins
     WHERE job_id = $1`,
    [jobId],
  );

  const now = Date.now();
  const stalePins: string[] = [];
  const zombiePins: string[] = [];

  for (const row of pinsRes.rows) {
    const ageSec = (now - row.created_at.getTime()) / 1000;
    const stillPlanned = livePlannedIds.has(row.planned_task_id);
    if (!stillPlanned) {
      // Task got picked up by a worker (or was deleted) → pin record
      // is stale. Only prune if the pin is at least 60s old, otherwise
      // it might just be a freshly-submitted pin not yet visible in
      // the start-of-tick planned snapshot.
      if (ageSec >= 60) stalePins.push(row.planned_task_id);
      continue;
    }
    if (!snapshot.onlineDevices.has(row.device_name)) {
      // Task is still planned AND its target device is no longer
      // online → zombie. Delete the planned task; the thermostat
      // will re-deploy on its next tick.
      zombiePins.push(row.planned_task_id);
    }
  }

  if (stalePins.length > 0) {
    await pool.query(
      `DELETE FROM agent_planned_pins WHERE planned_task_id = ANY($1::text[])`,
      [stalePins],
    ).catch(err => result.errors.push(`stale prune: ${(err as Error).message}`));
    result.stale = stalePins.length;
  }

  if (zombiePins.length > 0) {
    try {
      const r = await fetch(`${XGODO_API}/planned_tasks`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ planned_task_ids: zombiePins }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        result.errors.push(`zombie delete ${r.status}: ${text.slice(0, 200)}`);
      } else {
        await pool.query(
          `DELETE FROM agent_planned_pins WHERE planned_task_id = ANY($1::text[])`,
          [zombiePins],
        ).catch(err => result.errors.push(`zombie prune: ${(err as Error).message}`));
        result.zombieDeleted = zombiePins.length;
      }
    } catch (err) {
      result.errors.push(`zombie delete: ${(err as Error).message}`);
    }
  }

  return result;
}
