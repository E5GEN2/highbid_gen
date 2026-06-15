/**
 * Shared xgodo task helpers for the agent thermostat + admin endpoints.
 *
 * Why this lives separately: the thermostat and the /api/admin/agents endpoint
 * both need to count running tasks AND planned (unassigned) tasks, keyed by
 * keyword. Doing that in one place keeps the two in sync and avoids drift.
 */

const XGODO_API = 'https://xgodo.com/api/v2';

/**
 * A task's WORK UNIT — the thing it's researching. Two kinds:
 *   - keyword: legacy mode, identity = the search keyword
 *   - seed:    new video-URL mode, identity = the rofe-generated nicheId;
 *              seedUrl is the specific video the bot started crawling from
 *
 * `key` is the grouping/identity string used across the monitor,
 * thermostat targets, pins, and logs (keyword for keyword tasks, nicheId
 * for seed tasks). `keyword` is kept as an alias of `key` for backward
 * compatibility with callers that still read `.keyword`.
 */
export interface WorkUnit {
  kind: 'keyword' | 'seed' | 'unknown';
  key: string;
  seedUrl: string | null;
}

export interface RunningTaskInfo {
  taskId: string;
  /** Alias of workUnit.key — kept for back-compat. */
  keyword: string;
  kind: WorkUnit['kind'];
  seedUrl: string | null;
  startedAt: string | null;
  workerName: string | null;
}

export interface PlannedTaskInfo {
  plannedTaskId: string;
  /** Alias of workUnit.key — kept for back-compat. */
  keyword: string;
  kind: WorkUnit['kind'];
  seedUrl: string | null;
  added: string | null;   // creation timestamp — used to pick oldest for deletion
}

/**
 * Pull the work-unit out of either a planned_task input string or
 * job_proof object. Both arrive from xgodo as either a string (JSON) or
 * an already-parsed object.
 *
 * Seed-mode tasks carry `nicheId` + `seedUrl` (no keyword). Keyword-mode
 * tasks carry `keyword` (or search_query / searchQuery). nicheId takes
 * precedence so a task that somehow has both is grouped by niche.
 */
function extractWorkUnit(raw: unknown): WorkUnit {
  let obj: Record<string, unknown> = {};
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return { kind: 'unknown', key: 'unknown', seedUrl: null }; }
  } else if (raw && typeof raw === 'object') {
    obj = raw as Record<string, unknown>;
  }
  const nicheId = obj.nicheId ?? obj.niche_id;
  const seedUrl = (obj.seedUrl ?? obj.seed_url);
  if (typeof nicheId === 'string' && nicheId.length > 0) {
    return {
      kind: 'seed',
      key: nicheId,
      seedUrl: typeof seedUrl === 'string' ? seedUrl : null,
    };
  }
  const kw = obj.keyword || obj.search_query || obj.searchQuery;
  if (typeof kw === 'string' && kw.length > 0) {
    return { kind: 'keyword', key: kw, seedUrl: null };
  }
  return { kind: 'unknown', key: 'unknown', seedUrl: null };
}

/**
 * A single video record extracted from a task's job_proof — the durable
 * crawl-trace unit. A record is either:
 *   - WATCHED: the bot actually watched it (it's in exploreProgress.
 *     exploredChain / is the current enterVideo). orderNumber = its position
 *     in the watch path (1-based), hop = 0-based depth. This is the crawl
 *     PATH, in sequence.
 *   - DISCOVERED: a candidate the bot found (allDiscoveredVideos) but hasn't
 *     watched. watched=false.
 *
 * The real niche-spy bot job_proof (stage='Explore') looks like:
 *   { stage, action, seedUrl,
 *     enterVideo:{url,title,score,format,source},      // current video
 *     bestVideo:{url,title,score,...},                  // next-best pick
 *     allDiscoveredVideos:[{title,url,viewCount,subscriberCount,likeCount,
 *                           seenStatus,postedDate,format,source}],
 *     exploreProgress:{currentDepth,loopNumber,exploredChain:[…],reason} }
 * The watch order lives in exploreProgress.exploredChain (index = hop).
 * We also keep a generic fallback for the older flat list-of-videos shape.
 */
export interface ProofVideo {
  url: string;
  videoId: string | null;
  title: string | null;
  orderNumber: number | null;   // 1-based watch order; null = not watched
  hop: number | null;           // 0-based depth in the crawl chain
  watched: boolean;
  score: number | null;         // bot's pick score (enterVideo/bestVideo.score)
  similarity: number | null;    // legacy flat-form cosine (rare)
  channelName: string | null;
  subscriberCount: string | null; // raw label, e.g. "115K subscribers"
  viewCount: string | null;     // raw label, e.g. "662,583 views"
  likeCount: string | null;     // raw label, e.g. "25266"
  duration: string | null;      // raw label, e.g. "50:29"
  postedDate: string | null;    // ISO or label
  source: string | null;        // 'search' | 'suggested' | ...
  seenStatus: string | null;    // 'new' | 'already_seen'
  isNew: boolean | null;
  raw: Record<string, unknown> | null; // original entry, for future-proofing
}

const YT_ID_RE = /(?:v=|\/shorts\/|youtu\.be\/|\/watch\?v=)([A-Za-z0-9_-]{11})/;

function ytId(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const m = url.match(YT_ID_RE);
  return m ? m[1] : null;
}

function asNum(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function asStr(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number') return String(v);
  return null;
}

/**
 * Normalize one video-shaped object (from exploredChain, allDiscoveredVideos,
 * enterVideo, bestVideo, or a legacy flat record) into a ProofVideo. Handles a
 * string entry (bare url) too. Field aliases cover both the real Explore shape
 * and the older flat shape.
 */
function normalizeProofVideo(entry: unknown): ProofVideo | null {
  let o: Record<string, unknown>;
  if (typeof entry === 'string') {
    o = { url: entry };
  } else if (entry && typeof entry === 'object') {
    o = entry as Record<string, unknown>;
  } else {
    return null;
  }
  const url = (o.url ?? o.link ?? o.videoUrl ?? o.videoURL) as unknown;
  if (typeof url !== 'string' || !/youtu|watch\?v=/i.test(url)) return null;
  return {
    url,
    videoId: ytId(url),
    title: asStr(o.title),
    orderNumber: asNum(o.orderNumber),
    hop: asNum(o.hop ?? o.depth),
    watched: o.watched === true || o.watched === 'true',
    score: asNum(o.score),
    similarity: asNum(o.similarity),
    channelName: asStr(o.channelName ?? o.channel ?? o.channelTitle),
    subscriberCount: asStr(o.subscriberCount ?? o.subscribers ?? o.subs),
    viewCount: asStr(o.viewCount ?? o.views),
    likeCount: asStr(o.likeCount ?? o.likes),
    duration: asStr(o.duration),
    postedDate: asStr(o.postedDate ?? o.posted_at ?? o.publishedAt),
    source: asStr(o.source),
    seenStatus: asStr(o.seenStatus ?? o.seen_status),
    isNew: typeof o.isNew === 'boolean' ? o.isNew : (o.isNew === 'true' ? true : o.isNew === 'false' ? false : null),
    raw: typeof entry === 'object' ? (entry as Record<string, unknown>) : null,
  };
}

/** Merge two records for the same video, keeping the richest field from each. */
function mergeProof(prev: ProofVideo, v: ProofVideo): ProofVideo {
  return {
    ...prev,
    title: prev.title ?? v.title,
    orderNumber: prev.orderNumber ?? v.orderNumber,
    hop: prev.hop ?? v.hop,
    watched: prev.watched || v.watched,
    score: prev.score ?? v.score,
    similarity: prev.similarity ?? v.similarity,
    channelName: prev.channelName ?? v.channelName,
    subscriberCount: prev.subscriberCount ?? v.subscriberCount,
    viewCount: prev.viewCount ?? v.viewCount,
    likeCount: prev.likeCount ?? v.likeCount,
    duration: prev.duration ?? v.duration,
    postedDate: prev.postedDate ?? v.postedDate,
    source: prev.source ?? v.source,
    seenStatus: prev.seenStatus ?? v.seenStatus,
    isNew: prev.isNew ?? v.isNew,
    raw: prev.raw ?? v.raw,
  };
}

/**
 * Extract the crawl trace from a task's job_proof.
 *
 * Primary path = the real niche-spy Explore shape: the WATCH PATH is
 * exploreProgress.exploredChain (ordered, index = hop), the CANDIDATE POOL is
 * allDiscoveredVideos, and the CURRENT video is enterVideo. Watched videos are
 * enriched with metadata from allDiscoveredVideos (matched by id) since the
 * chain entries can be sparse. Falls back to a generic recursive walk for the
 * older flat list-of-videos shape. Returns watched-first (by orderNumber),
 * then discovered candidates.
 */
export function parseJobProofVideos(raw: unknown): ProofVideo[] {
  let root: unknown = raw;
  if (typeof root === 'string') {
    try { root = JSON.parse(root); } catch { return []; }
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    // An array at the top is the legacy flat shape — handle via walk below.
    if (!Array.isArray(root)) return [];
  }

  const obj = root as Record<string, unknown>;
  const ep = obj.exploreProgress as Record<string, unknown> | undefined;
  const hasExploreShape = !!ep || Array.isArray(obj.allDiscoveredVideos) || !!obj.enterVideo;

  const byKey = new Map<string, ProofVideo>();
  const put = (v: ProofVideo | null) => {
    if (!v) return;
    const key = v.videoId ?? v.url;
    const prev = byKey.get(key);
    byKey.set(key, prev ? mergeProof(prev, v) : v);
  };

  if (hasExploreShape) {
    // 1. Candidate pool — metadata-rich, used both as discovered candidates
    //    and to enrich the watched path.
    const discovered = Array.isArray(obj.allDiscoveredVideos) ? obj.allDiscoveredVideos : [];
    const metaById = new Map<string, ProofVideo>();
    for (const d of discovered) {
      const v = normalizeProofVideo(d);
      if (v) metaById.set(v.videoId ?? v.url, v);
    }

    // 2. Watch path (the crawl chain, in order). Each entry → watched, with
    //    its 1-based orderNumber + 0-based hop, enriched from the pool.
    const chain = Array.isArray(ep?.exploredChain) ? ep!.exploredChain as unknown[] : [];
    const watchedKeys = new Set<string>();
    chain.forEach((e, i) => {
      const v = normalizeProofVideo(e);
      if (!v) return;
      const key = v.videoId ?? v.url;
      const meta = metaById.get(key);
      const merged = meta ? mergeProof(meta, v) : v;
      merged.watched = true;
      merged.orderNumber = i + 1;
      merged.hop = i;
      watchedKeys.add(key);
      put(merged);
    });

    // 3. Current video being entered (enterVideo) — the in-progress hop, if
    //    not already counted in the chain. bestVideo carries the next pick's
    //    score; attach it as discovered.
    const enter = normalizeProofVideo(obj.enterVideo);
    if (enter) {
      const key = enter.videoId ?? enter.url;
      if (!watchedKeys.has(key)) {
        const meta = metaById.get(key);
        const merged = meta ? mergeProof(meta, enter) : enter;
        merged.watched = true;
        merged.orderNumber = chain.length + 1;
        merged.hop = (asNum(ep?.currentDepth) ?? chain.length);
        watchedKeys.add(key);
        put(merged);
      }
    }
    const best = normalizeProofVideo(obj.bestVideo);
    if (best && !watchedKeys.has(best.videoId ?? best.url)) put(best);

    // 4. Remaining discovered candidates (not watched).
    for (const [key, v] of metaById) {
      if (!watchedKeys.has(key)) put(v);
    }
  } else {
    // Legacy flat shape — walk the whole structure for video-shaped objects.
    const seen = new Set<unknown>();
    const walk = (node: unknown, depth: number) => {
      if (!node || typeof node !== 'object' || depth > 6) return;
      if (seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) { for (const el of node) walk(el, depth + 1); return; }
      const o = node as Record<string, unknown>;
      const v = normalizeProofVideo(o);
      if (v && ('title' in o || 'orderNumber' in o || 'similarity' in o || 'watched' in o || 'seenStatus' in o)) put(v);
      for (const k of Object.keys(o)) walk(o[k], depth + 1);
    };
    walk(root, 0);
  }

  return [...byKey.values()].sort((a, b) => {
    if (a.watched && b.watched) return (a.orderNumber ?? 1e9) - (b.orderNumber ?? 1e9);
    if (a.watched !== b.watched) return a.watched ? -1 : 1;
    // Discovered: rank by similarity (legacy) then score, then by 'new' first.
    const sa = a.similarity ?? a.score ?? -1;
    const sb = b.similarity ?? b.score ?? -1;
    return sb - sa;
  });
}

/** A task fetched from the applicants list, carrying its raw job_proof. */
export interface TaskWithProof {
  taskId: string;
  keyword: string;
  kind: WorkUnit['kind'];
  seedUrl: string | null;
  status: string | null;
  workerName: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  proof: ProofVideo[];
}

/**
 * Fetch tasks of a given status from the applicants list WITH their parsed
 * job_proof crawl trace. Used by the history endpoint to snapshot the
 * ephemeral watch-order before it ages out of xgodo.
 */
export async function fetchTasksByStatus(
  token: string,
  jobId: string,
  status: string,
  limit = 100,
): Promise<TaskWithProof[]> {
  const res = await fetch(`${XGODO_API}/jobs/applicants`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ job_id: jobId, status, limit }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`xgodo ${status} fetch failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json() as { job_tasks?: Array<Record<string, unknown>> };
  const tasks = data.job_tasks || [];
  return tasks.map(t => {
    const fromPlanned = extractWorkUnit(t.planned_task);
    const wu = fromPlanned.kind !== 'unknown' ? fromPlanned : extractWorkUnit(t.job_proof);
    return {
      taskId: String(t._id || t.job_task_id || ''),
      keyword: wu.key,
      kind: wu.kind,
      seedUrl: wu.seedUrl,
      status: (t.status as string) || status,
      workerName: (t.worker_name || null) as string | null,
      startedAt: (t.created_at || t.started_at || t.added || null) as string | null,
      finishedAt: (t.finished || t.updated_at || null) as string | null,
      proof: parseJobProofVideos(t.job_proof),
    };
  });
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

  return tasks.map(t => {
    // Prefer the planned_task input; fall back to job_proof if the task
    // hasn't surfaced its input (some running tasks only carry the proof).
    const fromPlanned = extractWorkUnit(t.planned_task);
    const wu = fromPlanned.kind !== 'unknown' ? fromPlanned : extractWorkUnit(t.job_proof);
    return {
      taskId: String(t._id || t.job_task_id || ''),
      keyword: wu.key,
      kind: wu.kind,
      seedUrl: wu.seedUrl,
      startedAt: (t.created_at || t.started_at || null) as string | null,
      workerName: (t.worker_name || null) as string | null,
    };
  });
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
      const wu = extractWorkUnit(r.input);
      out.push({
        plannedTaskId: String(r.planned_task_id || r._id || ''),
        keyword: wu.key,
        kind: wu.kind,
        seedUrl: wu.seedUrl,
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
