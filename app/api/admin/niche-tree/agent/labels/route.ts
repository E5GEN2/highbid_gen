import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { backfillClusterAiLabels } from '@/lib/cluster-labels';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 300;

/**
 * Admin endpoint to (re)label clusters via Gemini Flash.
 *
 * The TF-IDF auto_label baked by cluster-niches.py is English-biased
 * and produces nonsense for non-English clusters. ai_label fills that
 * gap: a Gemini call summarises the top titles + top channels into a
 * short label in the dominant language.
 *
 *   POST /api/admin/niche-tree/agent/labels
 *     body: {
 *       runId?: number,         // scope: only label this run's clusters (and L2 children); omit for all
 *       mode?: 'missing' | 'all', // default 'missing' — only labels nulls
 *       threads?: number          // default 10
 *     }
 *
 * Returns { ok, total, processed, upserted, skipped, errors }.
 *
 * Note: this runs synchronously and can take 10-15 min for a full
 * 5K-cluster relabel. The handler maxDuration is 300s; for large runs
 * the response will time out client-side but the server keeps writing
 * — re-poll with mode='missing' to see remaining count.
 */
export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const body = await req.json().catch(() => ({})) as {
    runId?: number;
    mode?: 'missing' | 'all';
    threads?: number;
  };

  try {
    const result = await backfillClusterAiLabels({
      mode: body.mode ?? 'missing',
      scope: body.runId ? { runId: body.runId } : 'all',
      threads: body.threads ?? 10,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message?.slice(0, 500) || 'unknown' },
      { status: 500 },
    );
  }
}
