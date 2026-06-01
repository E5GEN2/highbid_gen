/**
 * Video analysis pipeline — YouTube URL → continuous 1-4s timeline
 * with visual / speech / audio descriptions per segment.
 *
 * Stages (mirrors ytanal prototype):
 *   1. download    — yt-dlp via xgodo proxy
 *   2. split       — ffmpeg -c copy segments at ~60s (model accuracy
 *                    cliff above 60s; see ytanal calibration)
 *   3. analyze     — Gemini 2.5 Flash on each clip in parallel via
 *                    Google AI Studio key (xgodo_api_keys pool) + our
 *                    SOCKS5/static proxy pool. Rotates keys on 403/429
 *                    same as lib/embed-direct.ts.
 *   4. collapse    — offset each clip's segments by cumulative ffprobe
 *                    durations into one per-video timeline JSON.
 *
 * Persistence:
 *   - video_analysis_jobs(id, status, stage, …, timeline_jsonb)
 *   - video_analysis_clips(job_id, clip_index, status, attempts,
 *                          segments_jsonb, …)
 *
 * Concurrency: clip-level uses a single PROCESS-WIDE semaphore so
 * multiple jobs running in parallel can't blow past Gemini's per-key
 * per-minute caps. Per-job download/split run sequentially.
 *
 * Cost shape (rofe.ai keys, no papaiapi markup):
 *   ~15k input video tokens × $0.075/MTok + ~5k output × $0.30/MTok
 *   ≈ $0.003 per 60s clip × 15 clips ≈ $0.045 per 14-min video.
 *   Failures cost token-level pennies (no flat papaiapi $0.0005), but
 *   we retry from a 119-key pool so success is the common path.
 */

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { getPool } from './db';
import { CLIPS_DIR } from './clips-dir';
import { getRandomHealthyProxy } from './xgodo-proxy';
import { fetchViaProxy, type ProxyFetchResponse } from './proxy-dispatcher';

const execFileAsync = promisify(execFile);

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// Gemini inline data total-request cap is ~20MB. Base64 inflates 4/3,
// so we cap raw at 14MB → ~18.7MB body. A 60s 720p clip is 3-5MB raw,
// well under; the cap is a safety net for unusually-encoded sources.
// Anything over goes into error_category=too_large with no retry.
const MAX_CLIP_BYTES = 14 * 1024 * 1024;
const CLIP_SECONDS = 60;
const PER_CLIP_ATTEMPTS = 4;
const BACKOFF_SECONDS = [0, 5, 10, 15];
const PER_ATTEMPT_TIMEOUT_MS = 300_000;

// Process-wide cap on concurrent Gemini calls. Sized for a 119-key
// active pool: ~20 in flight at any moment keeps key freshness high
// (one bad key only ruins one call before rotation) without coming
// close to per-minute quota at the pool aggregate.
const GLOBAL_CLIP_CONCURRENCY = 20;

// Autopilot knobs.
// MAX_AUTO_RETRIES — how many times the watchdog will reset a job
//   before giving up. Each manual click on Retry does NOT increment
//   this, so the operator can always push past the cap. 5 covers
//   key-pool turbulence; beyond that the video is usually genuinely
//   unsalvageable (geo-blocked, age-restricted, deleted) and burning
//   more $ won't help.
// STUCK_AFTER_MINUTES — a job in flight whose last_progress_at hasn't
//   moved this long is treated as dead worker → reset to pending.
//   Conservative: a single clip can legitimately take ~5 min if all
//   four 300s attempts time out, so 15 min covers one clip stack-up
//   without false-positive-killing healthy jobs.
// TARGET_WORKERS — steady-state worker count the watchdog tops up to.
//   Matches the Enqueue form's `concurrentStarts` default.
// WATCHDOG_TICK_MS — period between heal/top-up passes.
const MAX_AUTO_RETRIES   = 5;
const STUCK_AFTER_MINUTES = 15;
const TARGET_WORKERS      = 5;
const WATCHDOG_TICK_MS    = 90_000;
let inflightClips = 0;
const clipQueue: Array<() => void> = [];

async function acquireClipSlot(): Promise<() => void> {
  if (inflightClips < GLOBAL_CLIP_CONCURRENCY) {
    inflightClips++;
  } else {
    await new Promise<void>(resolve => clipQueue.push(resolve));
    inflightClips++;
  }
  return () => {
    inflightClips--;
    const next = clipQueue.shift();
    if (next) next();
  };
}

// In-memory active worker count. Watchdog reads this to know how many
// more workers to spawn to maintain TARGET_WORKERS steady state.
let inflightJobs = 0;

// ────────────────────────────────────────────────────────────────────
// Public entry
// ────────────────────────────────────────────────────────────────────

/**
 * Drive one job through the full pipeline. Idempotent in spirit —
 * already-done clips are skipped on a retry, the collapse step
 * is deterministic given inputs.
 *
 * Throws are caught and converted to job status='error' so the
 * caller can fire-and-forget without leaking promise rejections.
 */
export async function runAnalysisJob(jobId: number): Promise<void> {
  // Boot the autopilot lazily on first job. setInterval persists in
  // the Node process; deduped via globalThis so dev-mode hot reload
  // doesn't stack multiple watchdogs.
  ensureWatchdog();
  inflightJobs++;
  try {
    const job = await loadJob(jobId);
    const dir = path.join(CLIPS_DIR, 'video_analysis', String(jobId));
    const clipsDir = path.join(dir, 'clips');
    fs.mkdirSync(clipsDir, { recursive: true });
    const sourcePath = path.join(dir, 'source.mp4');

    // Stage 1 — download. Skip if file already exists from a prior
    // partial run (idempotency hook).
    if (!fs.existsSync(sourcePath) || fs.statSync(sourcePath).size === 0) {
      await markJob(jobId, 'downloading', { source_mp4_path: sourcePath, clips_dir: clipsDir });
      await downloadSource(jobId, job.youtube_url, sourcePath);
    } else {
      await markJob(jobId, 'downloading', { source_mp4_path: sourcePath, clips_dir: clipsDir });
    }

    // Stage 2 — split. Reuse existing clip rows if present; otherwise
    // run ffmpeg and seed the table.
    await markJob(jobId, 'splitting');
    const clipFiles = await ensureClips(jobId, sourcePath, clipsDir);

    // Stage 3 — analyze. Only pending/error clip rows are touched.
    await markJob(jobId, 'analyzing', { num_clips: clipFiles.length });
    await analyzeClipsParallel(jobId);

    // Stage 4 — collapse the per-clip segments into one timeline.
    // Safe to re-run; idempotent and cheap.
    await markJob(jobId, 'collapsing');
    await collapseTimeline(jobId);

    await markJob(jobId, 'done', { completed_at_now: true });
  } catch (err) {
    const msg = (err as Error).message || 'unknown';
    console.error(`[video-analysis] job ${jobId} failed:`, err);
    await markJobError(jobId, msg);
  } finally {
    inflightJobs--;
    // Self-perpetuating queue drain. Once this worker exits (done,
    // error, whatever), atomically claim the next pending job and fire
    // its worker. The /jobs POST starts N workers — each one chains
    // into the next until pending is empty. No cron, no Drain queue
    // button mashing.
    //
    // Single-job claim per chain step (not batched) keeps the in-
    // flight worker count constant at the initial N; the FOR UPDATE
    // SKIP LOCKED makes concurrent chains safe.
    void claimAndRunNextPending().catch(err => {
      console.error('[video-analysis] queue chain failed:', err);
    });
  }
}

/**
 * Self-heal queue — resurrect anything stuck or failed-but-retriable.
 * Returns counts for telemetry. Called at every watchdog tick AND
 * before each chain-step claim so progress is continuous.
 *
 * Three buckets, all capped at MAX_AUTO_RETRIES per job:
 *   1. errored        — status='error' (whole-job failure, e.g. download)
 *   2. stuck-in-flight — downloading/splitting/analyzing/collapsing
 *                        with no last_progress_at update for STUCK_AFTER_MINUTES
 *   3. done-with-gaps  — status='done' but num_clips_failed > 0
 *
 * Increments auto_retry_count and stamps last_auto_retry_at; resets
 * relevant clip rows back to pending so the worker picks them up.
 */
async function selfHealQueue(): Promise<{ resetErrored: number; resetStuck: number; resetGaps: number }> {
  const pool = await getPool();

  // 1. Errored jobs → pending if under retry cap.
  const erroredRes = await pool.query<{ id: number }>(
    `UPDATE video_analysis_jobs
        SET status='pending', stage='pending',
            error_message=NULL, error_category=NULL,
            num_clips_failed=0, completed_at=NULL,
            auto_retry_count = auto_retry_count + 1,
            last_auto_retry_at = NOW(),
            last_progress_at  = NOW()
      WHERE status='error' AND auto_retry_count < $1
      RETURNING id`,
    [MAX_AUTO_RETRIES],
  );
  if (erroredRes.rows.length > 0) {
    await pool.query(
      `UPDATE video_analysis_clips
          SET status='pending', attempts='[]'::jsonb, attempt_count=0,
              error_category=NULL, error_detail=NULL, raw_debug_text=NULL,
              elapsed_s=NULL, started_at=NULL, completed_at=NULL
        WHERE job_id = ANY($1::int[]) AND status='error'`,
      [erroredRes.rows.map(r => r.id)],
    );
  }

  // 2. Stuck-in-flight → pending. Worker died mid-stage; reset any
  // 'running' clips so the next worker doesn't trip over zombies.
  //
  // Crucially: stuck reset does NOT respect MAX_AUTO_RETRIES and does
  // NOT increment auto_retry_count. A dead worker isn't a job failure
  // — the work never actually got a fair shot. Counting it as a retry
  // means a job that hit a deploy gap, OOM, or zombie state burns the
  // whole retry budget without ever genuinely failing, and then sits
  // permanently abandoned. The retry cap should only catch true
  // repeat-failures (error or done-with-gaps), not interrupted runs.
  const stuckRes = await pool.query<{ id: number }>(
    `UPDATE video_analysis_jobs
        SET status='pending', stage='pending',
            last_progress_at = NOW()
      WHERE status IN ('downloading','splitting','analyzing','collapsing')
        AND last_progress_at < NOW() - ($1 || ' minutes')::interval
      RETURNING id`,
    [String(STUCK_AFTER_MINUTES)],
  );
  if (stuckRes.rows.length > 0) {
    await pool.query(
      `UPDATE video_analysis_clips
          SET status='pending', started_at=NULL
        WHERE job_id = ANY($1::int[]) AND status='running'`,
      [stuckRes.rows.map(r => r.id)],
    );
  }

  // 3. Done-with-gaps → pending. Reset just the failed clips so the
  // worker only re-runs them (already-done clips stay done — no
  // re-paying for successful work). The collapse step rewrites the
  // timeline JSON on completion.
  const gappyRes = await pool.query<{ id: number }>(
    `UPDATE video_analysis_jobs
        SET status='pending', stage='pending',
            num_clips_failed=0, completed_at=NULL,
            auto_retry_count = auto_retry_count + 1,
            last_auto_retry_at = NOW(),
            last_progress_at  = NOW()
      WHERE status='done' AND num_clips_failed > 0
        AND auto_retry_count < $1
      RETURNING id`,
    [MAX_AUTO_RETRIES],
  );
  if (gappyRes.rows.length > 0) {
    await pool.query(
      `UPDATE video_analysis_clips
          SET status='pending', attempts='[]'::jsonb, attempt_count=0,
              error_category=NULL, error_detail=NULL, raw_debug_text=NULL,
              elapsed_s=NULL, started_at=NULL, completed_at=NULL
        WHERE job_id = ANY($1::int[]) AND status='error'`,
      [gappyRes.rows.map(r => r.id)],
    );
  }

  const out = {
    resetErrored: erroredRes.rows.length,
    resetStuck:   stuckRes.rows.length,
    resetGaps:    gappyRes.rows.length,
  };
  if (out.resetErrored + out.resetStuck + out.resetGaps > 0) {
    console.log(
      `[video-analysis] watchdog reset: ${out.resetErrored} errored, ` +
      `${out.resetStuck} stuck, ${out.resetGaps} done-with-gaps`,
    );
  }
  return out;
}

/**
 * Ensure TARGET_WORKERS workers are actively making progress. Uses the
 * DB as source of truth instead of the in-memory inflightJobs counter
 * — a worker that died mid-await (Gemini hang, ffmpeg zombie, OOM)
 * never ran its finally{} to decrement the counter, so the counter
 * lies and topUpWorkers thinks the pool is full.
 *
 * "Actively making progress" = in flight AND last_progress_at within
 * the last STUCK_AFTER_MINUTES window. Dead workers fail this check;
 * the watchdog's stuck-reset already moves their job rows to pending,
 * but topUpWorkers fires fresh workers immediately so we don't waste
 * a tick.
 *
 * Idempotent. Safe to call repeatedly.
 */
async function topUpWorkers(): Promise<void> {
  const pool = await getPool();
  const r = await pool.query<{ active: string }>(
    `SELECT COUNT(*)::text AS active
       FROM video_analysis_jobs
      WHERE status IN ('downloading','splitting','analyzing','collapsing')
        AND last_progress_at > NOW() - ($1 || ' minutes')::interval`,
    [String(STUCK_AFTER_MINUTES)],
  );
  const activeCount = parseInt(r.rows[0].active) || 0;
  // Re-sync in-memory counter to DB truth so other call sites that
  // read it (rare, but defensive) don't drift either.
  inflightJobs = activeCount;
  const need = Math.max(0, TARGET_WORKERS - activeCount);
  for (let i = 0; i < need; i++) {
    await claimAndRunNextPending();
  }
}

// Module-level watchdog. Persists until process restart.
// globalThis dedup prevents dev-mode hot reload from stacking multiple
// timers; in prod the module loads exactly once.
declare global {

  var __videoAnalysisWatchdog: NodeJS.Timeout | undefined;
}

function ensureWatchdog(): void {
  if (globalThis.__videoAnalysisWatchdog) return;
  globalThis.__videoAnalysisWatchdog = setInterval(async () => {
    try {
      await selfHealQueue();
      await topUpWorkers();
    } catch (err) {
      console.error('[video-analysis] watchdog tick failed:', err);
    }
  }, WATCHDOG_TICK_MS);
  console.log(`[video-analysis] watchdog started (tick=${WATCHDOG_TICK_MS}ms, target_workers=${TARGET_WORKERS}, max_auto_retries=${MAX_AUTO_RETRIES})`);
}

/**
 * Atomically claim one pending job and fire runAnalysisJob on it.
 * Called from runAnalysisJob's finally so each completed worker
 * picks up the next pending — turning a batch of 354 jobs into a
 * drainable queue with N always-running workers.
 *
 * Returns silently if no pending job; the chain just ends there.
 */
async function claimAndRunNextPending(): Promise<void> {
  // Pre-claim self-heal pass. If pending is empty but error/stuck/gap
  // jobs exist, this resurrects them so the next claim has something
  // to pick up. Cheap (3 indexed UPDATEs); safe to repeat.
  await selfHealQueue().catch(err => {
    console.error('[video-analysis] inline self-heal failed:', err);
  });

  const pool = await getPool();
  const r = await pool.query<{ id: number }>(
    `WITH claimed AS (
       SELECT id FROM video_analysis_jobs
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE video_analysis_jobs j
        SET status = 'downloading', stage = 'downloading',
            started_at = COALESCE(j.started_at, NOW()),
            last_progress_at = NOW()
       FROM claimed
      WHERE j.id = claimed.id
     RETURNING j.id`,
  );
  if (r.rows.length === 0) return;
  const nextId = r.rows[0].id;
  // Fire — runAnalysisJob's own finally will chain to whatever's next.
  void runAnalysisJob(nextId).catch(err => {
    console.error(`[video-analysis] chained job ${nextId} threw:`, err);
  });
}

// ────────────────────────────────────────────────────────────────────
// Stage 1 — download
// ────────────────────────────────────────────────────────────────────

async function downloadSource(jobId: number, youtubeUrl: string, outPath: string): Promise<void> {
  const proxy = await getRandomHealthyProxy();
  if (!proxy) throw new Error('no proxy available for yt-dlp');

  // dump-json first so we can stash title + duration even if the bulk
  // download fails later; helps users figure out which video died.
  let title: string | null = null;
  let duration: number | null = null;
  try {
    const { stdout } = await execFileAsync('yt-dlp', [
      '--dump-json', '--no-warnings', '--no-playlist',
      '--proxy', proxy.url, youtubeUrl,
    ], { timeout: 60_000, maxBuffer: 20 * 1024 * 1024 });
    const info = JSON.parse(stdout);
    title = typeof info.title === 'string' ? info.title.slice(0, 500) : null;
    duration = typeof info.duration === 'number' ? info.duration : null;
    const pool = await getPool();
    await pool.query(
      `UPDATE video_analysis_jobs
          SET source_video_title = COALESCE(source_video_title, $1),
              source_video_duration_s = COALESCE(source_video_duration_s, $2),
              last_progress_at = NOW()
        WHERE id = $3`,
      [title, duration, jobId],
    );
  } catch (e) {
    console.warn(`[video-analysis] job ${jobId} dump-json failed:`, (e as Error).message);
    // Don't bail — the binary download often works even when dump-json
    // gives up. We just lose the early title/duration.
  }

  await new Promise<void>((resolve, reject) => {
    const proc = spawn('yt-dlp', [
      '--merge-output-format', 'mp4',
      '-f', 'bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/b',
      '-o', outPath, '--no-warnings', '--no-playlist', '--newline',
      '--proxy', proxy.url, youtubeUrl,
    ]);
    const t = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('yt-dlp download timed out after 10 min'));
    }, 600_000);
    let stderr = '';
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', code => {
      clearTimeout(t);
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp exit ${code}: ${stderr.slice(-200)}`));
    });
    proc.on('error', err => { clearTimeout(t); reject(err); });
  });

  // If dump-json failed earlier, try ffprobe on the file we just got
  // so jobs always end up with a duration recorded.
  if (duration === null) {
    try {
      const dur = await ffprobeDuration(outPath);
      const pool = await getPool();
      await pool.query(
        `UPDATE video_analysis_jobs SET source_video_duration_s = $1, last_progress_at = NOW() WHERE id = $2`,
        [dur, jobId],
      );
    } catch { /* leave null — collapse step computes from clip sums */ }
  }
}

// ────────────────────────────────────────────────────────────────────
// Stage 2 — split + ffprobe each clip
// ────────────────────────────────────────────────────────────────────

async function ensureClips(jobId: number, sourcePath: string, clipsDir: string): Promise<string[]> {
  const pool = await getPool();
  // If clip rows already exist, trust them — Stage 1's "skip if
  // exists" already verified source.mp4 is on disk.
  const existing = await pool.query<{ clip_index: number; clip_path: string }>(
    `SELECT clip_index, clip_path FROM video_analysis_clips
       WHERE job_id = $1 AND clip_path IS NOT NULL
       ORDER BY clip_index`,
    [jobId],
  );
  if (existing.rows.length > 0 && existing.rows.every(r => fs.existsSync(r.clip_path))) {
    return existing.rows.map(r => r.clip_path);
  }

  // Fresh split.
  const pattern = path.join(clipsDir, 'part%03d.mp4');
  await execFileAsync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', sourcePath,
    '-c', 'copy', '-map', '0',
    '-f', 'segment', '-segment_time', String(CLIP_SECONDS), '-reset_timestamps', '1',
    pattern,
  ], { timeout: 600_000, maxBuffer: 50 * 1024 * 1024 });

  const clipFiles = fs.readdirSync(clipsDir)
    .filter(f => /^part\d+\.mp4$/.test(f))
    .sort()
    .map(f => path.join(clipsDir, f));
  if (clipFiles.length === 0) throw new Error('ffmpeg segment produced no clips');

  // Record each clip with its ffprobe duration. Sequential, but each
  // ffprobe is ~10-30ms — even 30 clips finish in <1s.
  const durations: number[] = [];
  for (let i = 0; i < clipFiles.length; i++) {
    const dur = await ffprobeDuration(clipFiles[i]);
    durations.push(dur);
    const stat = fs.statSync(clipFiles[i]);
    await pool.query(
      `INSERT INTO video_analysis_clips (job_id, clip_index, clip_path, duration_s, size_bytes, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       ON CONFLICT (job_id, clip_index) DO UPDATE
         SET clip_path = EXCLUDED.clip_path,
             duration_s = EXCLUDED.duration_s,
             size_bytes = EXCLUDED.size_bytes`,
      [jobId, i, clipFiles[i], dur, stat.size],
    );
  }
  await pool.query(
    `UPDATE video_analysis_jobs SET num_clips = $1, clip_durations = $2::real[], last_progress_at = NOW() WHERE id = $3`,
    [clipFiles.length, `{${durations.join(',')}}`, jobId],
  );
  return clipFiles;
}

async function ffprobeDuration(clipPath: string): Promise<number> {
  const { stdout } = await execFileAsync('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=nw=1:nk=1', clipPath,
  ], { timeout: 30_000 });
  const n = parseFloat(stdout.trim());
  if (!Number.isFinite(n)) throw new Error(`ffprobe returned non-numeric duration: ${stdout}`);
  return n;
}

// ────────────────────────────────────────────────────────────────────
// Stage 3 — analyze each clip via Gemini 2.5 Flash
// ────────────────────────────────────────────────────────────────────

async function analyzeClipsParallel(jobId: number): Promise<void> {
  const pool = await getPool();
  const { rows } = await pool.query<{ id: number; clip_index: number; clip_path: string; duration_s: number }>(
    `SELECT id, clip_index, clip_path, duration_s FROM video_analysis_clips
       WHERE job_id = $1 AND status IN ('pending', 'error')
       ORDER BY clip_index`,
    [jobId],
  );
  await Promise.all(rows.map(c => runOneClip(jobId, c.id, c.clip_path, c.duration_s)));
}

interface ClipAttemptLog {
  n: number;
  elapsed_s: number;
  category: string;
  http_status: number | null;
  detail: string | null;
}
interface CallResult {
  ok: boolean;
  segments?: Array<Record<string, unknown>>;
  category: string;
  httpStatus: number | null;
  detail: string | null;
  retriable: boolean;
  rawBody?: string | null;
}

async function runOneClip(jobId: number, clipRowId: number, clipPath: string, durationS: number): Promise<void> {
  const release = await acquireClipSlot();
  const pool = await getPool();
  try {
    await pool.query(
      `UPDATE video_analysis_clips
          SET status='running', started_at=COALESCE(started_at, NOW()),
              attempts='[]'::jsonb, attempt_count=0,
              error_category=NULL, error_detail=NULL, raw_debug_text=NULL
        WHERE id=$1`,
      [clipRowId],
    );
    const t0 = Date.now();
    const attempts: ClipAttemptLog[] = [];
    let lastErrCategory: string | null = null;
    let lastErrDetail: string | null = null;
    let lastRaw: string | null = null;

    for (let attemptN = 1; attemptN <= PER_CLIP_ATTEMPTS; attemptN++) {
      if (attemptN > 1) {
        const s = BACKOFF_SECONDS[Math.min(attemptN - 1, BACKOFF_SECONDS.length - 1)];
        await new Promise(r => setTimeout(r, s * 1000));
      }
      // Bump attempt_count + job last_progress_at on each attempt
      // start so the watchdog's stuck-detection (last_progress_at >
      // STUCK_AFTER_MINUTES) doesn't false-positive a worker that's
      // legitimately retrying.
      await pool.query(
        `UPDATE video_analysis_clips SET attempt_count=$1 WHERE id=$2`,
        [attemptN, clipRowId],
      ).catch(() => {});
      await pool.query(
        `UPDATE video_analysis_jobs SET last_progress_at=NOW() WHERE id=$1`,
        [jobId],
      ).catch(() => {});
      const aT0 = Date.now();
      const result = await callGeminiForClip(clipPath, durationS);
      const elapsed = (Date.now() - aT0) / 1000;
      attempts.push({ n: attemptN, elapsed_s: round(elapsed), category: result.category, http_status: result.httpStatus, detail: result.detail?.slice(0, 200) ?? null });

      if (result.ok && result.segments) {
        await pool.query(
          `UPDATE video_analysis_clips
              SET status='done', segments_jsonb=$1::jsonb, segments_count=$2,
                  attempts=$3::jsonb, attempt_count=$4, elapsed_s=$5,
                  completed_at=NOW(),
                  error_category=NULL, error_detail=NULL, raw_debug_text=NULL
            WHERE id=$6`,
          [JSON.stringify(result.segments), result.segments.length, JSON.stringify(attempts), attempts.length, round((Date.now() - t0) / 1000), clipRowId],
        );
        await bumpDoneCounter(jobId);
        return;
      }
      lastErrCategory = result.category;
      lastErrDetail = result.detail;
      if (result.rawBody) lastRaw = result.rawBody;
      if (!result.retriable) break;
    }

    // All attempts exhausted (or non-retriable abort).
    await pool.query(
      `UPDATE video_analysis_clips
          SET status='error', attempts=$1::jsonb, attempt_count=$2,
              error_category=$3, error_detail=$4, raw_debug_text=$5,
              elapsed_s=$6, completed_at=NOW()
        WHERE id=$7`,
      [
        JSON.stringify(attempts), attempts.length,
        lastErrCategory, lastErrDetail?.slice(0, 4000) ?? null,
        lastRaw ? lastRaw.slice(0, 200_000) : null,
        round((Date.now() - t0) / 1000),
        clipRowId,
      ],
    );
    await bumpFailedCounter(jobId);
  } finally {
    release();
  }
}

async function callGeminiForClip(clipPath: string, durationS: number): Promise<CallResult> {
  const keyRow = await pickHealthyAiKey();
  if (!keyRow) {
    return { ok: false, category: 'no_key', httpStatus: null, detail: 'no active google_ai_studio key', retriable: false };
  }
  const proxy = await getRandomHealthyProxy();
  if (!proxy) {
    return { ok: false, category: 'no_proxy', httpStatus: null, detail: 'no proxy available', retriable: true };
  }

  // Read + size-check the clip. If it exceeds Gemini's inline cap, run
  // it through an ffmpeg 480p / 400kbps downscale pass. Most 1080p
  // YouTube content produces 60s mp4 segments > 14MB at source bitrate
  // (8-12 Mbps); 480p@400kbps shrinks to ~3-5MB regardless of source,
  // which Gemini handles just as well for the descriptive task here.
  // The downscaled file is cached next to the source so retries reuse
  // it for free.
  let buf: Buffer;
  let clipPathForGemini = clipPath;
  try {
    const stat = fs.statSync(clipPath);
    if (stat.size > MAX_CLIP_BYTES) {
      const lowPath = clipPath.replace(/\.mp4$/, '.low.mp4');
      const tmpPath = lowPath + '.tmp';

      // If a cached low-res mp4 exists but is suspiciously tiny (likely
      // a partial output from a previous transcode that crashed mid-
      // write), nuke it so we re-transcode from scratch. Earlier
      // version reused these and ended up sending garbage to Gemini →
      // http_400 INVALID_ARGUMENT.
      if (fs.existsSync(lowPath)) {
        try {
          const s = fs.statSync(lowPath);
          if (s.size < 50 * 1024) {  // < 50 KB = definitely broken
            fs.unlinkSync(lowPath);
          }
        } catch { /* ignore */ }
      }

      if (!fs.existsSync(lowPath)) {
        // Always clean up any tmp residue before writing.
        try { fs.unlinkSync(tmpPath); } catch { /* not there, fine */ }
        try {
          await execFileAsync('ffmpeg', [
            '-y', '-hide_banner', '-loglevel', 'error',
            '-i', clipPath,
            '-vf', 'scale=-2:480',
            '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', '400k', '-maxrate', '500k', '-bufsize', '800k',
            '-c:a', 'aac', '-b:a', '64k',
            '-movflags', '+faststart',
            // Force mp4 container — without this, ffmpeg infers from
            // the output extension. Since we write to <foo>.low.mp4.tmp
            // for atomic rename safety, the trailing .tmp confused
            // ffmpeg into "Unable to find a suitable output format".
            // EVERY oversized clip's transcode failed because of this.
            '-f', 'mp4',
            tmpPath,
          ], { timeout: 120_000 });
        } catch (e) {
          // ffmpeg crashed — wipe any partial tmp so the next attempt
          // re-runs from scratch.
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          return { ok: false, category: 'transcode_failed', httpStatus: null, detail: (e as Error).message.slice(0, 500), retriable: true };
        }
        // Validate the tmp output is plausible before atomically
        // renaming to lowPath. Atomic rename means lowPath never
        // contains a half-written file.
        try {
          const tmpStat = fs.statSync(tmpPath);
          if (tmpStat.size < 50 * 1024) {
            try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
            return { ok: false, category: 'transcode_failed', httpStatus: null, detail: `transcode produced suspicious ${tmpStat.size}-byte output`, retriable: true };
          }
          fs.renameSync(tmpPath, lowPath);
        } catch (e) {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          return { ok: false, category: 'transcode_failed', httpStatus: null, detail: (e as Error).message.slice(0, 500), retriable: true };
        }
      }
      clipPathForGemini = lowPath;
    }
    buf = fs.readFileSync(clipPathForGemini);
  } catch (e) {
    return { ok: false, category: 'clip_read_failed', httpStatus: null, detail: (e as Error).message, retriable: false };
  }
  // Hard fall-through guard. Should never fire after transcode, but if
  // a clip is so weirdly large that even 480p/400kbps doesn't shrink
  // it under the cap, bail out and let ops inspect.
  if (buf.length > MAX_CLIP_BYTES) {
    return { ok: false, category: 'too_large', httpStatus: null, detail: `${buf.length} bytes > ${MAX_CLIP_BYTES} cap even after transcode`, retriable: false };
  }

  const body = JSON.stringify({
    contents: [{
      parts: [
        { text: buildAnalysisPrompt(durationS) },
        { inlineData: { mimeType: 'video/mp4', data: buf.toString('base64') } },
      ],
    }],
  });

  let res: ProxyFetchResponse;
  try {
    res = await fetchViaProxy(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keyRow.key },
      body,
      timeoutMs: PER_ATTEMPT_TIMEOUT_MS,
    }, proxy.url);
  } catch (e) {
    return mapConnectionError((e as Error).message || 'unknown');
  }

  // Read body once — we may need it for status-error detail AND for
  // parse_error debug text.
  let txt: string;
  try {
    txt = await res.text();
  } catch (e) {
    return { ok: false, category: 'body_read_failed', httpStatus: res.status, detail: (e as Error).message, retriable: true };
  }

  if (!res.ok) {
    // For http_400 ("INVALID_ARGUMENT"), nuke any cached low-res mp4
    // before returning. Gemini returning 400 on a video upload almost
    // always means the bytes are bad; our cache may have a corrupt
    // transcode output from a prior partial write. Forcing a fresh
    // transcode on the next attempt usually fixes it.
    if (res.status === 400) {
      const lowPath = clipPath.replace(/\.mp4$/, '.low.mp4');
      try { if (fs.existsSync(lowPath)) fs.unlinkSync(lowPath); } catch { /* ignore */ }
    }
    return mapHttpError(res.status, txt, keyRow.id);
  }

  // 200 OK. Parse the envelope, then the inner model text JSON.
  let envelope: { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  try {
    envelope = JSON.parse(txt) as typeof envelope;
  } catch (e) {
    return { ok: false, category: 'parse_error', httpStatus: res.status, detail: `envelope JSON parse: ${(e as Error).message}`, retriable: true, rawBody: txt };
  }
  const modelText = envelope.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
  if (!modelText) {
    return { ok: false, category: 'parse_error', httpStatus: res.status, detail: 'no candidates[0].content.parts[0].text', retriable: true, rawBody: txt };
  }

  // Strip ```json fences if present.
  const fenced = modelText.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
  const inner = fenced ? fenced[1] : modelText.trim();
  let payload: { segments?: Array<Record<string, unknown>> };
  try {
    payload = JSON.parse(inner) as typeof payload;
  } catch (e) {
    return { ok: false, category: 'parse_error', httpStatus: res.status, detail: `inner JSON parse: ${(e as Error).message}`, retriable: true, rawBody: txt };
  }
  if (!Array.isArray(payload.segments) || payload.segments.length === 0) {
    return { ok: false, category: 'parse_error', httpStatus: res.status, detail: 'no segments[] in model response', retriable: true, rawBody: txt };
  }
  return { ok: true, segments: payload.segments, category: 'ok', httpStatus: res.status, detail: null, retriable: false };
}

function mapConnectionError(msg: string): CallResult {
  const lc = msg.toLowerCase();
  if (lc.includes('timed out') || lc.includes('timeout')) return base('timeout', msg);
  if (lc.includes('econnreset') || lc.includes('connection reset')) return base('conn_reset', msg);
  if (lc.includes('econnrefused') || lc.includes('refused')) return base('conn_refused', msg);
  if (lc.includes('econnaborted') || lc.includes('abort')) return base('conn_aborted', msg);
  if (lc.includes('enotfound') || lc.includes('dns')) return base('dns', msg);
  if (lc.includes('socket hang up')) return base('socket_hang_up', msg);
  return base('other_conn', msg);
  function base(category: string, detail: string): CallResult {
    return { ok: false, category, httpStatus: null, detail, retriable: true };
  }
}

function mapHttpError(status: number, body: string, keyId: number): CallResult {
  const detail = body.slice(0, 1000);
  if (status === 403) {
    // PERMISSION_DENIED — kill the key. Most likely cause is the key
    // got revoked / billing detached / region-locked. embed-direct
    // uses the same rule and the pool has been stable since.
    invalidateKey(keyId, `gemini 403: ${detail.slice(0, 80)}`);
    return { ok: false, category: 'http_403', httpStatus: 403, detail, retriable: true };
  }
  if (status === 429) {
    // RATE_LIMIT or quota — cool the key off for 90s, retry with a
    // fresh one. Same playbook as embed-direct.
    cooloffKey(keyId, 90);
    return { ok: false, category: 'http_429', httpStatus: 429, detail, retriable: true };
  }
  if (status === 400) {
    // Flip to retriable=true because we just nuked the cached low-res
    // mp4 (see callGeminiForClip). The next attempt will re-transcode
    // from the original source and try again. If it's a genuine
    // INVALID_ARGUMENT (e.g. safety filter), all 4 attempts will
    // exhaust and the clip ends up in 'error' anyway.
    return { ok: false, category: 'http_400', httpStatus: 400, detail, retriable: true };
  }
  if (status === 401) return { ok: false, category: 'http_401', httpStatus: 401, detail, retriable: false };
  if (status === 413) return { ok: false, category: 'http_413', httpStatus: 413, detail, retriable: false };
  if (status >= 500 && status < 600) return { ok: false, category: `http_${status}`, httpStatus: status, detail, retriable: true };
  return { ok: false, category: `http_${status}`, httpStatus: status, detail, retriable: false };
}

async function pickHealthyAiKey(): Promise<{ id: number; key: string } | null> {
  const pool = await getPool();
  const r = await pool.query<{ id: number; key: string }>(
    `SELECT id, key
       FROM xgodo_api_keys
      WHERE service = 'google_ai_studio'
        AND status = 'active'
        AND (banned_until IS NULL OR banned_until < NOW())
      ORDER BY RANDOM()
      LIMIT 1`,
  );
  return r.rows[0] ?? null;
}

function invalidateKey(keyId: number, reason: string): void {
  void (async () => {
    try {
      const pool = await getPool();
      await pool.query(
        `UPDATE xgodo_api_keys SET status='invalid', invalidated_at=NOW() WHERE id=$1 AND status='active'`,
        [keyId],
      );
      console.log(`[video-analysis] invalidated key id=${keyId} (${reason})`);
    } catch { /* fire-and-forget */ }
  })();
}

function cooloffKey(keyId: number, seconds: number): void {
  void (async () => {
    try {
      const pool = await getPool();
      await pool.query(
        `UPDATE xgodo_api_keys SET banned_until = NOW() + ($1 || ' seconds')::interval WHERE id=$2`,
        [String(seconds), keyId],
      );
    } catch { /* fire-and-forget */ }
  })();
}

async function bumpDoneCounter(jobId: number): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE video_analysis_jobs SET num_clips_done = num_clips_done + 1, last_progress_at = NOW() WHERE id = $1`,
    [jobId],
  );
}

async function bumpFailedCounter(jobId: number): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE video_analysis_jobs SET num_clips_failed = num_clips_failed + 1, last_progress_at = NOW() WHERE id = $1`,
    [jobId],
  );
}

// ────────────────────────────────────────────────────────────────────
// Stage 4 — collapse per-clip segments into one timeline
// ────────────────────────────────────────────────────────────────────

async function collapseTimeline(jobId: number): Promise<void> {
  const pool = await getPool();
  const { rows: clipRows } = await pool.query<{
    clip_index: number;
    duration_s: number | null;
    segments_jsonb: Array<Record<string, unknown>> | null;
    status: string;
  }>(
    `SELECT clip_index, duration_s, segments_jsonb, status
       FROM video_analysis_clips
      WHERE job_id = $1
      ORDER BY clip_index`,
    [jobId],
  );
  const { rows: jobRows } = await pool.query<{
    source_video_title: string | null;
    clip_durations: number[] | null;
  }>(
    `SELECT source_video_title, clip_durations FROM video_analysis_jobs WHERE id = $1`,
    [jobId],
  );

  let offset = 0;
  const out: Array<Record<string, unknown>> = [];
  const missing: number[] = [];
  for (const c of clipRows) {
    const dur = c.duration_s ?? 0;
    if (c.status === 'done' && Array.isArray(c.segments_jsonb)) {
      for (const s of c.segments_jsonb) {
        const start = Number(s.start ?? 0);
        const end = Number(s.end ?? dur);
        out.push({
          start: round(start + offset),
          end: round(end + offset),
          visual_description: s.visual_description ?? '',
          speech_transcription: s.speech_transcription ?? '',
          audio_description: s.audio_description ?? '',
          clip_index: c.clip_index,
        });
      }
    } else {
      // Failed / unanalysed clip — drop a placeholder so the timeline
      // stays continuous. Downstream tooling distinguishes "no data
      // here" from "nothing here" via the placeholder marker.
      missing.push(c.clip_index);
      out.push({
        start: round(offset),
        end: round(offset + dur),
        visual_description: '[MISSING ANALYSIS]',
        speech_transcription: '',
        audio_description: '',
        clip_index: c.clip_index,
      });
    }
    offset += dur;
  }

  const timeline = {
    source_video: jobRows[0]?.source_video_title ?? null,
    video_duration_seconds: round(offset),
    num_clips: clipRows.length,
    missing_clip_indices: missing,
    clip_durations_s: jobRows[0]?.clip_durations ?? clipRows.map(c => c.duration_s ?? 0),
    total_segments: out.length,
    segments: out,
  };

  await pool.query(
    `UPDATE video_analysis_jobs
        SET timeline_jsonb = $1::jsonb, total_segments = $2,
            num_clips_failed = $3,
            last_progress_at = NOW()
      WHERE id = $4`,
    [JSON.stringify(timeline), out.length, missing.length, jobId],
  );
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

function round(n: number): number { return Math.round(n * 1000) / 1000; }

async function loadJob(jobId: number): Promise<{ youtube_url: string }> {
  const pool = await getPool();
  const r = await pool.query<{ youtube_url: string }>(
    `SELECT youtube_url FROM video_analysis_jobs WHERE id = $1`,
    [jobId],
  );
  if (!r.rows[0]) throw new Error(`job ${jobId} not found`);
  return r.rows[0];
}

async function markJob(jobId: number, status: string, extra?: Record<string, unknown> & { completed_at_now?: boolean }): Promise<void> {
  const pool = await getPool();
  const sets: string[] = ['status = $1', 'stage = $1', 'last_progress_at = NOW()'];
  const args: unknown[] = [status];
  // Stamp started_at on first transition out of pending.
  if (status === 'downloading') sets.push(`started_at = COALESCE(started_at, NOW())`);
  if (extra?.completed_at_now) sets.push(`completed_at = NOW()`);
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (k === 'completed_at_now') continue;
      args.push(v);
      sets.push(`${k} = $${args.length}`);
    }
  }
  args.push(jobId);
  await pool.query(`UPDATE video_analysis_jobs SET ${sets.join(', ')} WHERE id = $${args.length}`, args);
}

async function markJobError(jobId: number, error: string): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE video_analysis_jobs SET status='error', error_message=$1, completed_at=NOW() WHERE id=$2`,
    [error.slice(0, 4000), jobId],
  );
}

// ────────────────────────────────────────────────────────────────────
// Prompt — verbatim from the ytanal calibration. Duration is the
// load-bearing constraint; without it, Gemini hallucinates length.
// ────────────────────────────────────────────────────────────────────

function buildAnalysisPrompt(durationS: number): string {
  const d = durationS.toFixed(2);
  return `You are a professional video analyst. Analyze this video and produce a detailed timestamped breakdown in JSON format.

This clip is EXACTLY ${d} seconds long. Every timestamp you produce must fall within [0.0, ${d}]. The final segment's \`end\` MUST equal ${d}. The top-level \`video_duration_seconds\` MUST equal ${d}. Do NOT invent content beyond this duration.

Instructions
1. Watch the entire video carefully — both visuals and audio.
2. Segment the video into logical scenes/moments. A new segment starts when:
   * The visual scene changes (cut, transition, new location, new subject)
   * The speaker changes topic
   * There's a significant pause or shift in action
   * On-screen text or graphics appear/disappear
   * Segments must be 1-4 seconds. Never exceed 4 seconds per segment.
3. For each segment, provide:
   * start: timestamp in seconds (float)
   * end: timestamp in seconds (float)
   * visual_description: Describe what is visually happening — people, objects, actions, locations, camera movement, text on screen, graphics, transitions. Be specific and factual. Include details like clothing, colors, expressions, on-screen text verbatim.
   * speech_transcription: Transcribe ALL spoken words exactly as said. If no speech, use empty string "". Include the speaker identity if distinguishable (e.g. "Narrator:", "Man:", "Woman:").
   * audio_description: Describe non-speech audio — background music (genre/mood), sound effects, ambient noise, silence. If nothing notable, use empty string "".
4. Important rules:
   * Timestamps must be continuous with no gaps — every second of the video must be covered
   * Be precise with start/end times, aligned to actual scene boundaries
   * Transcribe speech word-for-word, not paraphrased
   * Note any on-screen text, watermarks, logos, subtitles verbatim
   * If someone is speaking over different visuals (voiceover), still capture both independently
   * For music, describe mood/genre rather than trying to identify the song
   * Total clip duration is ${d} seconds — do not exceed this
5. Output format — respond with ONLY this JSON, no other text:
{"video_duration_seconds": ${d}, "total_segments": <count>, "segments": [{"start": 0.0, "end": 3.5, "visual_description": "...", "speech_transcription": "...", "audio_description": "..."}, {"start": 3.5, "end": 7.0, "visual_description": "...", "speech_transcription": "...", "audio_description": "..."}]}

Analyze the entire video now. Do not skip any part. Output the complete JSON.`;
}

// ────────────────────────────────────────────────────────────────────
// Module-load side effect — eagerly start the watchdog whenever this
// lib is imported (which happens automatically when any analyze-vids
// API route is loaded). Ensures the autopilot survives Railway
// redeploys without needing a fresh POST to wake it up.
// ────────────────────────────────────────────────────────────────────
ensureWatchdog();
