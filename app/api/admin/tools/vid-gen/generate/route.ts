import { NextRequest, NextResponse } from 'next/server';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { getRandomProxy } from '@/lib/xgodo-proxy';
import crypto from 'crypto';

/**
 * POST /api/admin/tools/vid-gen/generate
 *
 * Generates video prompts at scale via Gemini Flash. Each batch is
 * a (key, proxy) pair pulled at random:
 *
 *   - key:   ORDER BY RANDOM() LIMIT 1 over the 2.7k active
 *            google_ai_studio rows — spreads quota across the pool.
 *   - proxy: getRandomProxy() over the healthy xgodo device list —
 *            spreads egress IP so we don't burn Railway's single IP
 *            against Gemini's per-source rate limit.
 *
 *   Both dimensions are rotated per attempt, not just per batch. A
 *   batch that fails retries up to 3 times with a fresh (key, proxy)
 *   pair before being counted as a permanent batch failure. The run
 *   only aborts when failure ratio crosses 50% AND we've actually
 *   tried ≥ 4 batches — way more tolerant than the old "5 cumulative
 *   errors and die" threshold.
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
const PER_BATCH_RETRIES = 3;
const SYNC_CAP = 50;
const BG_CAP = 1000;

interface BatchAttempt {
  prompts: string[];
  attempts: number;       // how many (key,proxy) tries this batch took
  lastError?: string;
}

/** Pick one random active google_ai_studio key. */
async function pickAiStudioKey(): Promise<{ id: number; key: string } | null> {
  const pool = await getPool();
  const r = await pool.query<{ id: number; key: string }>(
    `SELECT id, key
       FROM xgodo_api_keys
      WHERE service = 'google_ai_studio' AND status = 'active'
      ORDER BY RANDOM()
      LIMIT 1`,
  );
  return r.rows[0] ?? null;
}

/**
 * One Gemini call — pinned to a specific key + optional proxy URL.
 * Throws on any failure so the retry wrapper can swap the pair.
 */
async function generateOneBatch(
  apiKey: string,
  model: string,
  n: number,
  theme: string | null,
  proxyUrl: string | null,
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
  const init = {
    method: 'POST' as const,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: metaPrompt }] }],
      generationConfig: {
        temperature: 1.0,
        topP: 0.95,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
      },
    }),
    signal: AbortSignal.timeout(60_000),
  };

  // undici fetch when proxied, native fetch otherwise. Native fetch
  // doesn't honour `dispatcher` so we MUST use undici when proxying.
  const res = proxyUrl
    ? await undiciFetch(url, { ...init, dispatcher: new ProxyAgent(proxyUrl) })
    : await fetch(url, init);

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
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
 * fresh (key, proxy) pair. Returns whatever the last successful try
 * produced — or empty + lastError if all attempts failed.
 */
async function runOneBatchWithRetry(n: number, theme: string | null, model: string): Promise<BatchAttempt> {
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= PER_BATCH_RETRIES; attempt++) {
    const keyRow = await pickAiStudioKey();
    if (!keyRow) {
      return { prompts: [], attempts: attempt - 1, lastError: 'no_active_keys' };
    }
    // Proxy is optional — if the pool is empty/exhausted we fall back
    // to direct fetch rather than failing the batch.
    const proxy = await getRandomProxy().catch(() => null);
    try {
      const prompts = await generateOneBatch(keyRow.key, model, n, theme, proxy?.url ?? null);
      return { prompts, attempts: attempt, lastError };
    } catch (err) {
      lastError = (err as Error).message?.slice(0, 200);
    }
  }
  return { prompts: [], attempts: PER_BATCH_RETRIES, lastError };
}

/** Insert prompts. ON CONFLICT DO NOTHING handles cross-batch dedupe. */
async function insertPrompts(prompts: string[], batchId: string, model: string, theme: string | null): Promise<{ inserted: number; duplicates: number }> {
  if (prompts.length === 0) return { inserted: 0, duplicates: 0 };
  const unique = [...new Set(prompts)];
  const pool = await getPool();
  const placeholders = unique.map((_, i) => `($${i + 1}, 'ai-generated', $${unique.length + 1}::jsonb)`).join(',');
  const meta = JSON.stringify({ batchId, model, theme });
  const ins = await pool.query(
    `INSERT INTO video_prompts (prompt, source, generation_meta) VALUES ${placeholders}
       ON CONFLICT (prompt) DO NOTHING
       RETURNING id`,
    [...unique, meta],
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
  const theme = body.theme?.trim() || null;
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
