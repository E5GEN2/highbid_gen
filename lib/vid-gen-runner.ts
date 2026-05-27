/**
 * Vid Gen batch runner — extracted from
 * /api/admin/tools/vid-gen/generate/route.ts so the auto-refill path
 * triggered by /api/video_prompt can reuse the same code without an
 * HTTP self-call.
 *
 * Key/pool hygiene (mark 403 invalid, cooloff 429 for 90s, filter
 * banned_until on the picker) is preserved here. Direct fetch to
 * Gemini; the proxy layer's dead rate made it net-negative for this
 * specific endpoint at the volumes we run.
 */

import crypto from 'crypto';
import { getPool } from './db';

export const BATCH_SIZE = 25;
export const DEFAULT_MODEL = 'gemini-flash-latest';
const PER_BATCH_RETRIES = 8;

interface BatchAttempt {
  prompts: string[];
  attempts: number;
  lastError?: string;
}

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
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: metaPrompt }] }],
      generationConfig: {
        temperature: 1.0, topP: 0.95, maxOutputTokens: 4096,
        responseMimeType: 'application/json',
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    if (res.status === 403 && /PERMISSION_DENIED|has been (denied|suspended)/i.test(errBody)) {
      invalidateKey(keyId, `gemini_403: ${errBody.slice(0, 80)}`);
    }
    if (res.status === 429) cooloffKey(keyId, 90);
    throw new Error(`Gemini HTTP ${res.status}: ${errBody.slice(0, 200)}`);
  }
  const data = await res.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    error?: { message?: string };
  };
  if (data.error) throw new Error(`Gemini error: ${data.error.message?.slice(0, 200)}`);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
  if (!text) throw new Error('Gemini returned empty response');

  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed: unknown;
  try { parsed = JSON.parse(cleaned); }
  catch { throw new Error(`Failed to parse Gemini JSON: ${cleaned.slice(0, 200)}`); }
  if (!Array.isArray(parsed)) throw new Error('Gemini response was not a JSON array');
  return parsed
    .filter((s): s is string => typeof s === 'string')
    .map(s => s.trim())
    .filter(s => s.length > 0 && s.length <= 2000);
}

async function runOneBatchWithRetry(n: number, theme: string | null, model: string): Promise<BatchAttempt> {
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= PER_BATCH_RETRIES; attempt++) {
    const keyRow = await pickAiStudioKey();
    if (!keyRow) return { prompts: [], attempts: attempt - 1, lastError: 'no_active_keys' };
    try {
      const prompts = await generateOneBatch(keyRow.id, keyRow.key, model, n, theme);
      return { prompts, attempts: attempt, lastError };
    } catch (err) {
      lastError = (err as Error).message?.slice(0, 200);
    }
  }
  return { prompts: [], attempts: PER_BATCH_RETRIES, lastError };
}

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

export async function createRunRow(runId: string, opts: {
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

export async function finalizeRun(runId: string, status: 'done' | 'failed', lastError?: string): Promise<void> {
  const pool = await getPool();
  await pool.query(
    `UPDATE vid_gen_runs SET status = $1, completed_at = NOW(), last_error = COALESCE($2, last_error) WHERE id = $3`,
    [status, lastError ?? null, runId],
  );
}

export async function runGeneration(opts: {
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

/**
 * Auto-refill trigger. Called from /api/video_prompt after each pop.
 *
 * Reads vid_gen_settings. If auto_refill_enabled AND the current
 * available count is < auto_refill_threshold, fires a background
 * generation of auto_refill_target prompts using the saved theme.
 *
 * Idempotent under bursts: skips if any vid_gen_runs row is already
 * in status='running'. So 50 concurrent pops can't spawn 50 refills.
 */
export async function triggerAutoRefillIfNeeded(): Promise<{ triggered: boolean; reason: string; runId?: string }> {
  const pool = await getPool();
  // Read settings.
  const sRes = await pool.query<{
    auto_theme: string;
    auto_refill_enabled: boolean;
    auto_refill_threshold: number;
    auto_refill_target: number;
  }>(
    `SELECT auto_theme, auto_refill_enabled, auto_refill_threshold, auto_refill_target
       FROM vid_gen_settings WHERE id = 1`,
  );
  const s = sRes.rows[0];
  if (!s) return { triggered: false, reason: 'no_settings_row' };
  if (!s.auto_refill_enabled) return { triggered: false, reason: 'disabled' };

  // Cheap atomic check: is any generation already running?
  const running = await pool.query<{ id: string }>(
    `SELECT id FROM vid_gen_runs WHERE status = 'running' LIMIT 1`,
  );
  if (running.rows.length > 0) {
    return { triggered: false, reason: 'in_flight', runId: running.rows[0].id };
  }

  // Same available-row predicate the picker uses (so the count matches
  // what clients will actually see).
  const cRes = await pool.query<{ available: string }>(
    `SELECT COUNT(*)::text AS available FROM video_prompts
      WHERE confirmed_at IS NULL
        AND (served_at IS NULL OR served_at < NOW() - INTERVAL '5 minutes')`,
  );
  const available = parseInt(cRes.rows[0]?.available ?? '0') || 0;
  if (available >= s.auto_refill_threshold) {
    return { triggered: false, reason: `above_threshold(${available} >= ${s.auto_refill_threshold})` };
  }

  // Fire it.
  const runId = crypto.randomUUID();
  const target = Math.max(1, Math.min(s.auto_refill_target, 1000));
  const theme = s.auto_theme?.trim() || null;
  const concurrency = 6;
  await createRunRow(runId, { mode: 'background', count: target, theme, model: DEFAULT_MODEL, concurrency });

  void (async () => {
    try {
      await runGeneration({ runId, count: target, theme, model: DEFAULT_MODEL, concurrency });
    } catch (err) {
      await finalizeRun(runId, 'failed', (err as Error).message?.slice(0, 200)).catch(() => {});
    }
  })();

  console.log(`[vid-gen] auto-refill triggered: available=${available} < threshold=${s.auto_refill_threshold}; generating ${target} via theme=${JSON.stringify(theme)}`);
  return { triggered: true, reason: `below_threshold(${available} < ${s.auto_refill_threshold})`, runId };
}
