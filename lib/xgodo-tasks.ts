/**
 * Shared xgodo task helpers for the agent thermostat + admin endpoints.
 *
 * Why this lives separately: the thermostat and the /api/admin/agents endpoint
 * both need to count running tasks AND planned (unassigned) tasks, keyed by
 * keyword. Doing that in one place keeps the two in sync and avoids drift.
 */

const XGODO_API = 'https://xgodo.com/api/v2';

export interface RunningTaskInfo {
  taskId: string;
  keyword: string;
  startedAt: string | null;
  workerName: string | null;
}

export interface PlannedTaskInfo {
  plannedTaskId: string;
  keyword: string;
  added: string | null;   // creation timestamp — used to pick oldest for deletion
}

/**
 * Pull the keyword out of either a planned_task input string or job_proof object.
 * Both arrive from xgodo as either a string (JSON) or an already-parsed object.
 */
function extractKeyword(raw: unknown): string {
  let obj: Record<string, unknown> = {};
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return 'unknown'; }
  } else if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  }
  const kw = obj.keyword || obj.search_query || obj.searchQuery;
  return typeof kw === 'string' && kw.length > 0 ? kw : 'unknown';
}

/**
 * List running tasks for a job. Returns only tasks with status='running'.
 */
export async function fetchRunningTasks(token: string, jobId: string): Promise<RunningTaskInfo[]> {
  const res = await fetch(`${XGODO_API}/jobs/applicants`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId, status: 'running', limit: 100 }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`xgodo running fetch failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json() as { job_tasks?: Array<Record<string, unknown>> };
  const tasks = data.job_tasks || [];

  return tasks.map(t => ({
    taskId: String(t._id || t.job_task_id || ''),
    keyword: extractKeyword(t.planned_task) !== 'unknown'
      ? extractKeyword(t.planned_task)
      : extractKeyword(t.job_proof),
    startedAt: (t.created_at || t.started_at || null) as string | null,
    workerName: (t.worker_name || null) as string | null,
  }));
}

/**
 * List planned tasks for a job — these are tasks that have NOT been assigned to
 * a device yet (job_task_id IS NULL). Paginated; we fetch until we've got them
 * all or hit a safety cap. Per xgodo docs the endpoint returns only unassigned.
 */
export async function fetchPlannedTasks(
  token: string,
  jobId: string,
  opts: { maxPages?: number; pageLimit?: number } = {},
): Promise<PlannedTaskInfo[]> {
  const maxPages = opts.maxPages ?? 10;
  const pageLimit = opts.pageLimit ?? 100;
  const out: PlannedTaskInfo[] = [];

  for (let page = 1; page <= maxPages; page++) {
    const url = `${XGODO_API}/planned_tasks?job_id=${encodeURIComponent(jobId)}&page=${page}&limit=${pageLimit}&sortOrder=asc`;
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`xgodo planned fetch failed (page ${page}): ${res.status} ${text.slice(0, 200)}`);
    }
    const payload = await res.json() as {
      success?: boolean;
      data?: {
        plannedTasks?: Array<{ planned_task_id?: string; _id?: string; input?: unknown; added?: string }>;
        total?: number;
      };
    };
    const rows = payload.data?.plannedTasks || [];
    if (rows.length === 0) break;

    for (const r of rows) {
      out.push({
        plannedTaskId: String(r.planned_task_id || r._id || ''),
        keyword: extractKeyword(r.input),
        added: r.added || null,
      });
    }

    const total = payload.data?.total;
    if (typeof total === 'number' && out.length >= total) break;
    if (rows.length < pageLimit) break;
  }

  return out;
}

/**
 * Delete unassigned planned tasks by ID. xgodo refuses to delete tasks that are
 * already assigned to a device, so this is safe — the worst case is a 4xx that
 * we swallow and try again next tick.
 */
export async function deletePlannedTasks(
  token: string,
  plannedTaskIds: string[],
): Promise<{ ok: boolean; status: number; error?: string }> {
  if (plannedTaskIds.length === 0) return { ok: true, status: 200 };
  const res = await fetch(`${XGODO_API}/planned_tasks`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ planned_task_ids: plannedTaskIds }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: text.slice(0, 200) };
  }
  return { ok: true, status: res.status };
}

/**
 * Count in-flight tasks per keyword (running + planned).
 * Also returns the planned-task IDs per keyword, sorted oldest-first, so
 * callers can cherry-pick which to delete on over-provisioning.
 */
export function countInFlight(
  running: RunningTaskInfo[],
  planned: PlannedTaskInfo[],
): Record<string, { running: number; planned: number; inFlight: number; plannedIds: string[] }> {
  const result: Record<string, { running: number; planned: number; inFlight: number; plannedIds: string[] }> = {};
  const ensure = (kw: string) => {
    if (!result[kw]) result[kw] = { running: 0, planned: 0, inFlight: 0, plannedIds: [] };
    return result[kw];
  };
  for (const r of running) ensure(r.keyword).running++;
  // Sort planned oldest-first so plannedIds[0] is the first to delete
  const plannedSorted = [...planned].sort((a, b) => {
    const ta = a.added ? new Date(a.added).getTime() : 0;
    const tb = b.added ? new Date(b.added).getTime() : 0;
    return ta - tb;
  });
  for (const p of plannedSorted) {
    const rec = ensure(p.keyword);
    rec.planned++;
    rec.plannedIds.push(p.plannedTaskId);
  }
  for (const kw in result) result[kw].inFlight = result[kw].running + result[kw].planned;
  return result;
}
