import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import crypto from 'crypto';

/**
 * POST /api/admin/tools/vid-gen/generate
 *
 * Generates video prompts at scale via Gemini Flash, using a
 * known-active google_ai_studio key from xgodo_api_keys. Results
 * are inserted into video_prompts with source='ai-generated' and
 * a generation_meta JSON blob carrying the batch id, model, theme,
 * and key prefix for forensics.
 *
 * Body:
 *   {
 *     count?:  number;   // total prompts to generate. default 50,
 *                        //   capped at 50 in sync mode and 1000
 *                        //   in background mode.
 *     theme?:  string;   // optional steering — "AI faceless YT
 *                        //   shorts about urban legends", etc.
 *                        //   Folded into the meta-prompt.
 *     model?:  string;   // default 'gemini-flash-latest'
 *     background?: boolean;
 *   }
 *
 * Auth: admin Bearer token.
 *
 * Gemini is called directly via the AI Studio endpoint
 * (generativelanguage.googleapis.com) — no xgodo proxy stack
 * involved, so this isn't bottlenecked by the proxy issues that
 * affect YouTube Data API calls.
 *
 * Implementation pattern: chunk the requested count into 25-prompt
 * batches, ask Gemini to return JSON array of strings per batch,
 * parse + dedupe, insert with ON CONFLICT DO NOTHING. Continues on
 * a per-batch failure (logs, skips the batch). Returns aggregate
 * stats.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

const BATCH_SIZE = 25;          // prompts per Gemini call
const DEFAULT_MODEL = 'gemini-flash-latest';

interface GenerateResult {
  requested: number;
  generated: number;
  inserted: number;
  duplicatesSkipped: number;
  batches: number;
  errors: string[];
  batchId: string;
}

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
 * One Gemini batch — asks the model for `n` prompts and parses the
 * JSON array reply. Resilient to the model wrapping its output in
 * ```json fences (strip them before JSON.parse).
 */
async function generateOneBatch(
  apiKey: string,
  model: string,
  n: number,
  theme: string | null,
): Promise<string[]> {
  const themeClause = theme
    ? `Theme: ${theme}\n\n`
    : '';
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
        temperature: 1.0,
        topP: 0.95,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
      },
    }),
    signal: AbortSignal.timeout(60_000),
  });
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

  // Strip ``` fences if the model still emitted them despite the
  // responseMimeType hint.
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

async function runGeneration(opts: {
  count: number;
  theme: string | null;
  model: string;
  batchId: string;
}): Promise<GenerateResult> {
  const result: GenerateResult = {
    requested: opts.count,
    generated: 0,
    inserted: 0,
    duplicatesSkipped: 0,
    batches: 0,
    errors: [],
    batchId: opts.batchId,
  };
  let remaining = opts.count;
  const pool = await getPool();

  while (remaining > 0) {
    const n = Math.min(BATCH_SIZE, remaining);
    const keyRow = await pickAiStudioKey();
    if (!keyRow) {
      result.errors.push('no active google_ai_studio key available');
      break;
    }
    result.batches++;
    try {
      const prompts = await generateOneBatch(keyRow.key, opts.model, n, opts.theme);
      result.generated += prompts.length;

      if (prompts.length > 0) {
        // Dedupe within this batch + ON CONFLICT on the UNIQUE prompt
        // column for cross-batch dedupe.
        const unique = [...new Set(prompts)];
        const placeholders = unique.map((_, i) => `($${i + 1}, 'ai-generated', $${unique.length + 1}::jsonb)`).join(',');
        const meta = JSON.stringify({
          batchId: opts.batchId,
          model: opts.model,
          theme: opts.theme,
          keyPreview: `${keyRow.key.slice(0, 12)}…`,
        });
        const ins = await pool.query(
          `INSERT INTO video_prompts (prompt, source, generation_meta) VALUES ${placeholders}
             ON CONFLICT (prompt) DO NOTHING
             RETURNING id`,
          [...unique, meta],
        );
        result.inserted += ins.rowCount ?? 0;
        result.duplicatesSkipped += unique.length - (ins.rowCount ?? 0);
      }
      remaining -= n;
    } catch (err) {
      result.errors.push(`batch ${result.batches} (${(err as Error).message?.slice(0, 150)})`);
      // Don't decrement remaining on failure — the loop will retry
      // by picking a different random key next iteration. Bail if
      // we've accumulated too many errors to avoid burning all
      // keys on a misconfigured generation.
      if (result.errors.length >= 5) {
        result.errors.push('too many batch failures, aborting');
        break;
      }
    }
  }
  return result;
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const body = await req.json().catch(() => ({})) as {
    count?: number; theme?: string; model?: string; background?: boolean;
  };
  const background = !!body.background;
  const count = Math.max(1, Math.min(body.count ?? 50, background ? 1000 : 50));
  const theme = body.theme?.trim() || null;
  const model = body.model?.trim() || DEFAULT_MODEL;
  const batchId = crypto.randomUUID();

  if (background) {
    // Fire and forget. No run-table writes here since this is a
    // one-shot tool; the prompts table itself is the durable log
    // (filterable by generation_meta.batchId). Future improvement:
    // surface progress via a vid_gen_runs table.
    (async () => {
      try {
        await runGeneration({ count, theme, model, batchId });
      } catch {
        // already logged inside runGeneration via errors[]
      }
    })();
    return NextResponse.json({
      ok: true,
      mode: 'background',
      batchId,
      count,
      message: `Generating ${count} prompts in the background — poll via GET /api/admin/tools/vid-gen?source=ai-generated to watch the queue grow.`,
    });
  }

  const result = await runGeneration({ count, theme, model, batchId });
  return NextResponse.json({ ok: true, mode: 'sync', ...result });
}
