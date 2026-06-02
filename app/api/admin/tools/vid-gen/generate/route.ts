import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { getRandomHealthyProxy } from '@/lib/xgodo-proxy';
import { fetchViaProxy } from '@/lib/proxy-dispatcher';
import crypto from 'crypto';

/**
 * POST /api/admin/tools/vid-gen/generate
 *
 * Generates video prompts at scale via Gemini Flash. Each attempt
 * picks a fresh random key from the active google_ai_studio pool.
 *
 * Direct fetch, no proxy. Empirically (via /vid-gen/diag) the xgodo
 * proxy pool is currently ~67% dead-on-connect for Gemini, which
 * compounds with the key pool's banned-key rate to produce ~5× more
 * total failures than direct fetch from Railway. Per-IP rate limits
 * on Gemini aren't significant at the volumes this tool runs — only
 * 1/12 proxied probes hit a 429 — so we don't need IP rotation to
 * survive.
 *
 * Banned-key cleanup: 403 PERMISSION_DENIED responses ("project has
 * been denied access" / "Consumer ... has been suspended") are
 * terminal — the key is dead and will keep returning the same 403
 * forever. We mark such keys status='invalid' immediately so future
 * picks skip them, shrinking the effective pool to healthy keys over
 * time. Same approach already used in lib/embeddings.ts via
 * classifyKeyError + deleteApiKey.
 *
 * A batch that fails retries up to PER_BATCH_RETRIES times with a
 * fresh key. The run only aborts when failure ratio crosses 50%
 * AND we've actually tried ≥ 4 batches.
 *
 * Body:
 *   { count?: number;            // total prompts. sync ≤ 50, bg ≤ 1000
 *     theme?: string;             // optional steering
 *     model?: string;             // default 'gemini-flash-latest'
 *     background?: boolean;
 *     concurrency?: number;       // parallel batches in bg mode, 1-12
 *   }
 *
 * Sync response: full result inline.
 * Background response: { ok, runId, count } — poll GET ?runId=… .
 *
 * GET /api/admin/tools/vid-gen/generate
 *   ?runId=<uuid>   → row for a specific run
 *   no params       → most recent 20 runs (audit log)
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

const BATCH_SIZE = 25;
const DEFAULT_MODEL = 'gemini-flash-latest';
// 8 retries handles a ~50% live-proxy rate gracefully: P(all 8 dead) ≈ 0.4%.
// Bounded so a fully-dead pool doesn't burn the whole maxDuration window.
const PER_BATCH_RETRIES = 8;
const SYNC_CAP = 50;
const BG_CAP = 1000;

interface BatchAttempt {
  prompts: string[];
  attempts: number;       // how many (key,proxy) tries this batch took
  lastError?: string;
}

/** Pick one random google_ai_studio key that isn't currently cooling
 *  off from a 429. Without the banned_until filter, a key just rejected
 *  for per-minute quota would be re-pickable on the next retry. */
async function pickAiStudioKey(): Promise<{ id: number; key: string } | null> {
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

/** Soft cooloff for a key that hit per-minute quota (429). Lets the
 *  minute window slide before we touch this key again. Fire-and-forget. */
function cooloffKey(keyId: number, seconds: number = 90): void {
  void (async () => {
    try {
      const pool = await getPool();
      await pool.query(
        `UPDATE xgodo_api_keys
            SET banned_until = NOW() + ($1 || ' seconds')::interval
          WHERE id = $2`,
        [String(seconds), keyId],
      );
    } catch { /* fire-and-forget */ }
  })();
}

/**
 * Mark a key as terminally invalid in xgodo_api_keys. Fire-and-forget
 * so the caller's request path doesn't wait on the UPDATE. Used when
 * Gemini returns 403 PERMISSION_DENIED — the key is dead, will only
 * ever return the same 403, no point keeping it in the active pool.
 */
function invalidateKey(keyId: number, reason: string): void {
  void (async () => {
    try {
      const pool = await getPool();
      await pool.query(
        `UPDATE xgodo_api_keys SET status = 'invalid', invalidated_at = NOW()
          WHERE id = $1 AND status = 'active'`,
        [keyId],
      );
      console.log(`[vid-gen] Invalidated key id=${keyId} (${reason})`);
    } catch (err) {
      console.warn('[vid-gen] invalidateKey failed:', (err as Error).message);
    }
  })();
}

/**
 * One Gemini call — pinned to a specific key. Throws on any failure
 * so the retry wrapper can swap the key. On 403 PERMISSION_DENIED we
 * also flag the key for invalidation as a side effect.
 */
async function generateOneBatch(
  keyId: number,
  apiKey: string,
  model: string,
  n: number,
  theme: string | null,
): Promise<string[]> {
  const themeClause = theme ? `Theme: ${theme}\n\n` : '';
  const metaPrompt =
`You are generating creative short-form video prompts.
${themeClause}Output ${n} unique, vivid 1-2 sentence prompts that could be turned into 5-15 second AI-generated videos. Each prompt should evoke a specific scene, mood, or action — concrete, visual, no abstractions.

Return ONLY a JSON array of strings. No prose, no markdown, no fence blocks.

Example output for n=3:
["A red panda balancing on a unicycle through a neon-lit Tokyo alley at night",
 "Macro shot of raindrops bouncing off a sunflower petal in slow motion",
 "An astronaut planting a single tulip on the surface of Mars at sunrise"]`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: metaPrompt }] }],
    generationConfig: {
      temperature: 1.0,
      topP: 0.95,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json',
    },
  });

  // Route through the platform proxy pool — gives Google a different
  // egress IP per call than the embedding workers' parallel traffic,
  // so the two systems don't share a per-IP rate-limit bucket. Falls
  // back to direct fetch only if the pool is empty.
  const proxy = await getRandomHealthyProxy().catch(() => null);
  let res: { ok: boolean; status: number; text(): Promise<string>; json(): Promise<unknown> };
  if (proxy?.url) {
    res = await fetchViaProxy(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      timeoutMs: 60_000,
    }, proxy.url);
  } else {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(60_000),
    });
    res = { ok: r.ok, status: r.status, text: () => r.text(), json: () => r.json() };
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    // 403 PERMISSION_DENIED = terminally dead key. Mark it invalid so
    // future ORDER BY RANDOM() picks skip it and the effective pool
    // shrinks to working keys.
    if (res.status === 403 && /PERMISSION_DENIED|has been (denied|suspended)/i.test(errBody)) {
      invalidateKey(keyId, `gemini_403: ${errBody.slice(0, 80)}`);
    }
    // 429 = per-minute project quota hit. Cool the key off for 90s so
    // the next retry doesn't keep re-rolling it from the random pool.
    if (res.status === 429) {
      cooloffKey(keyId, 90);
    }
    throw new Error(`Gemini HTTP ${res.status}: ${errBody.slice(0, 200)}`);
  }
  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    error?: { message?: string };
  };
  if (data.error) throw new Error(`Gemini error: ${data.error.message?.slice(0, 200)}`);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) throw new Error('Gemini returned empty response');

  const cleaned = text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  let parsed: unknown;
  try { parsed = JSON.parse(cleaned); }
  catch { throw new Error(`Failed to parse Gemini JSON: ${cleaned.slice(0, 200)}`); }
  if (!Array.isArray(parsed)) throw new Error('Gemini response was not a JSON array');
  return parsed
    .filter((s): s is string => typeof s === 'string')
    .map(s => s.trim())
    .filter(s => s.length > 0 && s.length <= 2000);
}

/**
 * Try one batch up to PER_BATCH_RETRIES times, each attempt with a
 * fresh key. Returns the first successful result, or empty + lastError
 * if every attempt failed. Banned keys are pruned as a side effect via
 * invalidateKey() so subsequent picks land on healthy ones faster.
 */
async function runOneBatchWithRetry(n: number, theme: string | null, model: string): Promise<BatchAttempt> {
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= PER_BATCH_RETRIES; attempt++) {
    const keyRow = await pickAiStudioKey();
    if (!keyRow) {
      return { prompts: [], attempts: attempt - 1, lastError: 'no_active_keys' };
    }
    try {
      const prompts = await generateOneBatch(keyRow.id, keyRow.key, model, n, theme);
      return { prompts, attempts: attempt, lastError };
    } catch (err) {
      lastError = (err as Error).message?.slice(0, 200);
    }
  }
  return { prompts: [], attempts: PER_BATCH_RETRIES, lastError };
}

/** Read the admin-selected target_model from vid_gen_settings — the
 *  Veo Lite / Veo Omni choice clients receive alongside each prompt.
 *  Defensive default so a never-initialised settings row doesn't break
 *  the insert. */
async function readTargetModel(): Promise<string> {
  const pool = await getPool();
  const r = await pool.query<{ target_model: string }>(
    `SELECT target_model FROM vid_gen_settings WHERE id = 1`,
  ).catch(() => ({ rows: [] as Array<{ target_model: string }> }));
  return r.rows[0]?.target_model || 'veo-omni';
}

/** Insert prompts. ON CONFLICT DO NOTHING handles cross-batch dedupe.
 *  Each row is stamped with the admin-selected target_model so the
 *  client knows which Veo flavour to render with. */
async function insertPrompts(prompts: string[], batchId: string, model: string, theme: string | null): Promise<{ inserted: number; duplicates: number }> {
  if (prompts.length === 0) return { inserted: 0, duplicates: 0 };
  const unique = [...new Set(prompts)];
  const targetModel = await readTargetModel();
  const pool = await getPool();
  const placeholders = unique
    .map((_, i) => `($${i + 1}, 'ai-generated', $${unique.length + 1}::jsonb, $${unique.length + 2})`)
    .join(',');
  const meta = JSON.stringify({ batchId, model, theme });
  const ins = await pool.query(
    `INSERT INTO video_prompts (prompt, source, generation_meta, target_model) VALUES ${placeholders}
       ON CONFLICT (prompt) DO NOTHING
       RETURNING id`,
    [...unique, meta, targetModel],
  );
  const inserted = ins.rowCount ?? 0;
  return { inserted, duplicates: unique.length - inserted };
}

/** Initial run row insert — visible immediately via GET ?runId=…. */
async function createRunRow(runId: string, opts: {
  mode: 'sync' | 'background';
  count: number;
  theme: string | null;
  model: string;
  concurrency: number;
}): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO vid_gen_runs (id, mode, count_requested, theme, model, concurrency)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [runId, opts.mode, opts.count, opts.theme, opts.model, opts.concurrency],
  );
}

/** Periodic progress update. Cheap enough to call after every batch. */
async function updateRunProgress(runId: string, patch: {
  count_generated?: number;
  count_inserted?: number;
  count_duplicates?: number;
  batches_total?: number;
  batches_failed?: number;
  last_error?: string | null;
}): Promise<void> {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    params.push(v as string | number | null);
    sets.push(`${k} = $${params.length}`);
  }
  if (sets.length === 0) return;
  params.push(runId);
  const pool = await getPool();
  await pool.query(`UPDATE vid_gen_runs SET ${sets.join(', ')} WHERE id = $${params.length}`, params);
}

async function finalizeRun(runId: string, status: 'done' | 'failed', lastError?: string): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE vid_gen_runs SET status = $1, completed_at = NOW(), last_error = COALESCE($2, last_error) WHERE id = $3`,
    [status, lastError ?? null, runId],
  );
}

/**
 * Driver — runs a worker pool over the queue of batch sizes. Each
 * worker pulls a batch off the queue, runs it (with retries), inserts
 * results, updates progress. Aborts the whole run only if the fail
 * ratio exceeds 50% AND we've tried ≥ 4 batches (so a small unlucky
 * run doesn't kill itself prematurely).
 */
async function runGeneration(opts: {
  runId: string;
  count: number;
  theme: string | null;
  model: string;
  concurrency: number;
}): Promise<void> {
  const queue: number[] = [];
  let remaining = opts.count;
  while (remaining > 0) {
    const n = Math.min(BATCH_SIZE, remaining);
    queue.push(n);
    remaining -= n;
  }

  let totalGenerated = 0, totalInserted = 0, totalDupes = 0;
  let batchesDone = 0, batchesFailed = 0;
  let aborted = false;
  let lastError: string | undefined;

  const worker = async () => {
    while (!aborted) {
      const n = queue.shift();
      if (n === undefined) return;
      const res = await runOneBatchWithRetry(n, opts.theme, opts.model);
      if (res.prompts.length === 0) {
        batchesFailed++;
        if (res.lastError) lastError = res.lastError;
      } else {
        totalGenerated += res.prompts.length;
        const { inserted, duplicates } = await insertPrompts(res.prompts, opts.runId, opts.model, opts.theme);
        totalInserted += inserted;
        totalDupes += duplicates;
      }
      batchesDone++;
      await updateRunProgress(opts.runId, {
        count_generated: totalGenerated,
        count_inserted: totalInserted,
        count_duplicates: totalDupes,
        batches_total: batchesDone,
        batches_failed: batchesFailed,
        last_error: lastError ?? null,
      }).catch(() => {});

      if (batchesDone >= 4 && batchesFailed / batchesDone > 0.5) {
        aborted = true;
        lastError = `aborted: failure ratio ${batchesFailed}/${batchesDone}`;
      }
    }
  };

  const workers = Array.from({ length: opts.concurrency }, () => worker());
  await Promise.all(workers);

  await finalizeRun(opts.runId, aborted ? 'failed' : 'done', lastError);
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const body = await req.json().catch(() => ({})) as {
    count?: number; theme?: string; model?: string;
    background?: boolean; concurrency?: number;
  };
  const background = !!body.background;
  const count = Math.max(1, Math.min(body.count ?? 50, background ? BG_CAP : SYNC_CAP));
  // Theme resolution order:
  //   1. body.theme           (caller wants a one-off steering for this run)
  //   2. vid_gen_settings.auto_theme  (the saved theme — what the auto-refill
  //                                    path uses)
  //   3. null                 (truly no steering — Gemini gets the generic
  //                            prompt)
  // Without step 2, clicking "Generate 50" with the theme field empty
  // produced unsteered random prompts even when the operator had a saved
  // theme — confusing because the auto-refill path WAS using it.
  let theme: string | null = body.theme?.trim() || null;
  if (theme === null) {
    try {
      const pool = await getPool();
      const r = await pool.query<{ auto_theme: string }>(
        `SELECT auto_theme FROM vid_gen_settings WHERE id = 1`,
      );
      const saved = r.rows[0]?.auto_theme?.trim();
      if (saved) theme = saved;
    } catch { /* settings missing — fall through with null */ }
  }
  const model = body.model?.trim() || DEFAULT_MODEL;
  const concurrency = background
    ? Math.max(1, Math.min(body.concurrency ?? 6, 12))
    : 1;

  const runId = crypto.randomUUID();
  await createRunRow(runId, { mode: background ? 'background' : 'sync', count, theme, model, concurrency });

  if (background) {
    // Fire-and-forget. The run row is the durable progress log so the
    // caller can drop the connection and poll later.
    void (async () => {
      try {
        await runGeneration({ runId, count, theme, model, concurrency });
      } catch (err) {
        await finalizeRun(runId, 'failed', (err as Error).message?.slice(0, 200)).catch(() => {});
      }
    })();
    return NextResponse.json({
      ok: true,
      mode: 'background',
      runId,
      count,
      concurrency,
      message: `Generating ${count} prompts in the background (${concurrency} workers). Poll GET /api/admin/tools/vid-gen/generate?runId=${runId}.`,
    });
  }

  await runGeneration({ runId, count, theme, model, concurrency });

  const pool = await getPool();
  const r = await pool.query(`SELECT * FROM vid_gen_runs WHERE id = $1`, [runId]);
  const row = r.rows[0];
  return NextResponse.json({
    ok: true,
    mode: 'sync',
    runId,
    requested: row.count_requested,
    generated: row.count_generated,
    inserted: row.count_inserted,
    duplicates: row.count_duplicates,
    batches: row.batches_total,
    batchesFailed: row.batches_failed,
    lastError: row.last_error,
    status: row.status,
  });
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const pool = await getPool();

  // Sweep stale 'running' rows. maxDuration is 300s; anything still
  // running after 10 minutes is wedged (deploy mid-flight, OOM, etc.)
  // and shouldn't keep flashing as in-progress in the UI.
  await pool.query(
    `UPDATE vid_gen_runs
        SET status = 'failed',
            completed_at = NOW(),
            last_error = COALESCE(last_error, 'stale: exceeded 10min without completion')
      WHERE status = 'running'
        AND started_at < NOW() - INTERVAL '10 minutes'`,
  ).catch(() => {});

  const runId = req.nextUrl.searchParams.get('runId');
  if (runId) {
    const r = await pool.query(`SELECT * FROM vid_gen_runs WHERE id = $1`, [runId]);
    if (r.rows.length === 0) return NextResponse.json({ error: 'run not found' }, { status: 404 });
    const row = r.rows[0];
    return NextResponse.json({
      ok: true,
      run: {
        id: row.id,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        status: row.status,
        mode: row.mode,
        countRequested: row.count_requested,
        countGenerated: row.count_generated,
        countInserted: row.count_inserted,
        countDuplicates: row.count_duplicates,
        batchesTotal: row.batches_total,
        batchesFailed: row.batches_failed,
        theme: row.theme,
        model: row.model,
        lastError: row.last_error,
        concurrency: row.concurrency,
      },
    });
  }

  const limit = Math.max(1, Math.min(parseInt(req.nextUrl.searchParams.get('limit') || '20'), 100));
  const r = await pool.query(
    `SELECT * FROM vid_gen_runs ORDER BY started_at DESC LIMIT $1`,
    [limit],
  );
  return NextResponse.json({
    ok: true,
    runs: r.rows.map(row => ({
      id: row.id,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      status: row.status,
      mode: row.mode,
      countRequested: row.count_requested,
      countGenerated: row.count_generated,
      countInserted: row.count_inserted,
      countDuplicates: row.count_duplicates,
      batchesTotal: row.batches_total,
      batchesFailed: row.batches_failed,
      theme: row.theme,
      model: row.model,
      lastError: row.last_error,
      concurrency: row.concurrency,
    })),
  });
}
