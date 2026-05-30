import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { getRandomHealthyProxy } from '@/lib/xgodo-proxy';
import { fetchViaProxy } from '@/lib/proxy-dispatcher';

/**
 * POST /api/admin/embed-debug/key-sweep
 *
 * Probes a sample of active google_ai_studio keys against Gemini with
 * a minimal generateContent call. Classifies each by response code and
 * mutates xgodo_api_keys accordingly so the pool shrinks to genuinely-
 * working keys.
 *
 *   200 / 400        → key works, leave active
 *   403 (denied|suspended) → mark invalid permanently
 *   429              → marked invalid too (per operator intel: the
 *                      "Quota exceeded for project_number:N" template
 *                      is most often a banned-key signal in this pool,
 *                      not a real per-minute quota that resets)
 *   network / other  → leave alone (transient)
 *
 * Body:
 *   { sample?: number;   // how many random active keys to probe (default 100, max 500)
 *     concurrency?: number;  // parallel probes (default 8, max 20)
 *     dryRun?: boolean;  // probe + classify only, no DB writes
 *   }
 *
 * Auth: admin Bearer token.
 *
 * Returns { ok, sampled, kept, invalidated, networkErrors, byClass, durationMs }.
 *
 * Routes through the platform proxy pool (static SOCKS5 list) so the
 * sweep itself can't get the Railway IP banned and so the per-call
 * shape matches what real embedding/vid-gen traffic looks like.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

interface KeyRow { id: number; key: string; }

interface KeyOutcome {
  id: number;
  status: number | null;
  errorClass: 'ok' | 'denied' | 'suspended' | 'quota' | 'network' | 'other';
  detail?: string;
}

async function probeOne(key: KeyRow): Promise<KeyOutcome> {
  const proxy = await getRandomHealthyProxy().catch(() => null);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${key.key}`;
  const body = JSON.stringify({
    contents: [{ parts: [{ text: 'reply OK' }] }],
    generationConfig: { maxOutputTokens: 8 },
  });
  try {
    let res: { ok: boolean; status: number; text(): Promise<string> };
    if (proxy?.url) {
      res = await fetchViaProxy(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        timeoutMs: 20_000,
      }, proxy.url);
    } else {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(20_000),
      });
      res = { ok: r.ok, status: r.status, text: () => r.text() };
    }
    if (res.ok) return { id: key.id, status: res.status, errorClass: 'ok' };
    const errBody = await res.text().catch(() => '');
    if (res.status === 403) {
      if (/has been suspended/i.test(errBody)) {
        return { id: key.id, status: res.status, errorClass: 'suspended', detail: errBody.slice(0, 80) };
      }
      if (/PERMISSION_DENIED|has been denied/i.test(errBody)) {
        return { id: key.id, status: res.status, errorClass: 'denied', detail: errBody.slice(0, 80) };
      }
    }
    if (res.status === 429) {
      return { id: key.id, status: res.status, errorClass: 'quota', detail: errBody.slice(0, 80) };
    }
    return { id: key.id, status: res.status, errorClass: 'other', detail: errBody.slice(0, 80) };
  } catch (err) {
    return { id: key.id, status: null, errorClass: 'network', detail: (err as Error).message?.slice(0, 80) };
  }
}

export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as { sample?: number; concurrency?: number; dryRun?: boolean };
  const sample = Math.max(1, Math.min(body.sample ?? 100, 500));
  const concurrency = Math.max(1, Math.min(body.concurrency ?? 8, 20));
  const dryRun = !!body.dryRun;

  const pool = await getPool();
  const r = await pool.query<KeyRow>(
    `SELECT id, key FROM xgodo_api_keys
      WHERE service = 'google_ai_studio'
        AND status = 'active'
        AND (banned_until IS NULL OR banned_until < NOW())
      ORDER BY RANDOM() LIMIT $1`,
    [sample],
  );
  const keys = r.rows;
  if (keys.length === 0) return NextResponse.json({ ok: true, sampled: 0, detail: 'no active keys' });

  const t0 = Date.now();
  // Tiny worker pool — concurrency caps parallelism without queuing.
  const results: KeyOutcome[] = [];
  let cursor = 0;
  async function worker() {
    while (cursor < keys.length) {
      const i = cursor++;
      results.push(await probeOne(keys[i]));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, keys.length) }, () => worker()));
  const durationMs = Date.now() - t0;

  // Classification → mutation. Both 403-suspended and 403-denied are
  // terminal. 429 is treated terminal per the operator's intel that
  // the templated quota error is usually a banned-key dressed up to
  // look like a quota hit in this pool.
  const toInvalidate = results
    .filter(r => r.errorClass === 'denied' || r.errorClass === 'suspended' || r.errorClass === 'quota')
    .map(r => r.id);

  if (!dryRun && toInvalidate.length > 0) {
    await pool.query(
      `UPDATE xgodo_api_keys
          SET status = 'invalid', invalidated_at = NOW()
        WHERE id = ANY($1::int[]) AND status = 'active'`,
      [toInvalidate],
    );
  }

  const byClass: Record<string, number> = {};
  for (const r of results) {
    byClass[r.errorClass] = (byClass[r.errorClass] ?? 0) + 1;
  }

  return NextResponse.json({
    ok: true,
    sampled: keys.length,
    durationMs,
    byClass,
    kept: byClass.ok ?? 0,
    invalidated: dryRun ? 0 : toInvalidate.length,
    wouldInvalidate: dryRun ? toInvalidate.length : undefined,
    networkErrors: byClass.network ?? 0,
    samples: results.slice(0, 20),  // small detail tail for eyeballing
    dryRun,
  });
}
