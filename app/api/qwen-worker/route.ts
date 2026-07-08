import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import {
  QWEN_DIM,
  ensureQwenTables,
  persistVectors,
  stampOnly,
  type BackfillRow,
} from '@/lib/qwen-embed';

/**
 * PULL-based Qwen embedding workers (no ngrok needed).
 *
 * A Colab GPU worker (qwen_embedding_worker.ipynb) makes OUTBOUND calls only:
 *   POST {action:'claim',  batch:N}                 → rows to embed (soft-claimed 15 min)
 *   POST {action:'submit', results:[{id,embedding}], failed:[ids]} → persist + stamp
 *   GET                                             → queue status
 *
 * Multiple workers can run in parallel — claims use FOR UPDATE SKIP LOCKED and
 * a claim expires after 15 min, so a killed Colab never strands its batch.
 *
 * Auth: Authorization: Bearer <qwen_worker_token from admin_config> — a
 * dedicated narrow token so notebooks never hold an admin credential.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

const CLAIM_EXPIRY = '15 minutes';
const MAX_BATCH = 48;

async function checkWorkerAuth(req: NextRequest): Promise<boolean> {
  const auth = req.headers.get('authorization') || '';
  if (!auth.startsWith('Bearer ')) return false;
  const token = auth.slice(7).trim();
  if (!token) return false;
  const pool = await getPool();
  const r = await pool.query<{ value: string }>(
    `SELECT value FROM admin_config WHERE key = 'qwen_worker_token'`,
  );
  return !!r.rows[0]?.value && r.rows[0].value === token;
}

export async function GET(req: NextRequest) {
  if (!(await checkWorkerAuth(req))) return NextResponse.json({ error: 'Invalid worker token' }, { status: 401 });
  const pool = await getPool();
  const r = await pool.query<{ queue: string; claimed: string; done: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE qwen_embedded_v1_at IS NULL
         AND title IS NOT NULL AND title <> '' AND thumbnail IS NOT NULL AND thumbnail <> ''
         AND thumbnail_dead_at IS NULL) AS queue,
       COUNT(*) FILTER (WHERE qwen_embedded_v1_at IS NULL AND qwen_claimed_at > NOW() - INTERVAL '${CLAIM_EXPIRY}') AS claimed,
       COUNT(*) FILTER (WHERE qwen_embedded_v1_at IS NOT NULL) AS done
     FROM niche_spy_videos`,
  );
  return NextResponse.json({
    dim: QWEN_DIM,
    queueRemaining: parseInt(r.rows[0].queue),
    claimedNow: parseInt(r.rows[0].claimed),
    embeddedTotal: parseInt(r.rows[0].done),
  });
}

export async function POST(req: NextRequest) {
  if (!(await checkWorkerAuth(req))) return NextResponse.json({ error: 'Invalid worker token' }, { status: 401 });
  const body = await req.json().catch(() => ({}));
  const pool = await getPool();

  if (body.action === 'claim') {
    const batch = Math.max(1, Math.min(MAX_BATCH, parseInt(body.batch) || 12));
    await ensureQwenTables().catch(() => {});
    // Atomic claim: SKIP LOCKED keeps concurrent workers off each other's rows;
    // expired claims (dead worker) are re-claimable.
    const rows = await pool.query<BackfillRow>(
      `UPDATE niche_spy_videos SET qwen_claimed_at = NOW()
        WHERE id IN (
          SELECT id FROM niche_spy_videos
           WHERE qwen_embedded_v1_at IS NULL
             AND (qwen_claimed_at IS NULL OR qwen_claimed_at < NOW() - INTERVAL '${CLAIM_EXPIRY}')
             AND title IS NOT NULL AND title <> ''
             AND thumbnail IS NOT NULL AND thumbnail <> ''
             AND thumbnail_dead_at IS NULL
           ORDER BY id DESC
           LIMIT $1
           FOR UPDATE SKIP LOCKED
        )
        RETURNING id, title, thumbnail, keyword`,
      [batch],
    );
    return NextResponse.json({ rows: rows.rows, dim: QWEN_DIM });
  }

  if (body.action === 'submit') {
    const results: Array<{ id: number; embedding: number[] }> = Array.isArray(body.results) ? body.results : [];
    const failed: number[] = Array.isArray(body.failed) ? body.failed.map((x: unknown) => parseInt(String(x))).filter(Number.isFinite) : [];

    const valid: BackfillRow[] = [];
    const vectors: number[][] = [];
    const rejected: number[] = [];
    for (const r of results) {
      const id = parseInt(String(r.id));
      if (!Number.isFinite(id) || !Array.isArray(r.embedding) || r.embedding.length !== QWEN_DIM
          || !r.embedding.every(x => typeof x === 'number' && Number.isFinite(x))) {
        rejected.push(id);
        continue;
      }
      // persistVectors only needs id/keyword/title for the upsert; keyword and
      // title were stored at claim time by the worker — refetch to stay truthful.
      valid.push({ id, title: '', thumbnail: '', keyword: null });
      vectors.push(r.embedding);
    }
    // Re-attach title/keyword from the DB (don't trust worker-echoed content).
    if (valid.length > 0) {
      const meta = await pool.query<{ id: number; title: string; keyword: string | null }>(
        `SELECT id, title, keyword FROM niche_spy_videos WHERE id = ANY($1::int[])`,
        [valid.map(v => v.id)],
      );
      const m = new Map(meta.rows.map(r => [r.id, r]));
      for (const v of valid) {
        const row = m.get(v.id);
        if (row) { v.title = row.title; v.keyword = row.keyword; }
      }
    }

    const persisted = valid.length > 0 ? await persistVectors(valid, vectors) : 0;
    await stampOnly(failed); // permanently skip (bad thumbnail etc.) — no vector row
    return NextResponse.json({ ok: true, persisted, skipped: failed.length, rejected });
  }

  return NextResponse.json({ error: "action must be 'claim' or 'submit'" }, { status: 400 });
}
