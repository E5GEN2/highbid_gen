import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { expandFromSeed } from '@/lib/video-seed';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

/**
 * POST /api/niche-spy/video-seed/expand
 *
 * Niche expansion via video-seed cosine similarity. The replacement
 * for the keyword-driven Gemini scoring loop xgodo agents use today.
 *
 * Body:
 *   {
 *     seedUrl:        string;            // canonical YT URL of the seed video
 *     candidateUrls:  string[];          // suggested-video URLs scraped by xgodo
 *     topK?:          number;            // default 20 if neither topK nor minSimilarity provided
 *     minSimilarity?: number;            // cosine threshold (0-1). overrides topK
 *     taskId?:        string;            // xgodo task id for live-feed filtering
 *     keyword?:       string;            // optional niche tag for grouping
 *   }
 *
 * Auth: admin Bearer token (`hba_...`).
 *
 * Returns SeedExpandResult — see lib/video-seed.ts. Persists every
 * (seed, candidate, similarity) tuple into niche_seed_expansions so
 * the admin live feed picks them up immediately.
 *
 * Cost vs the current Gemini-chat-scoring path:
 *   embedding tokens (cheap) instead of chat tokens (expensive)
 *   1 KNN cosine vs the seed (~ms) instead of 1 Gemini call (~seconds)
 *   Net: ~95% cheaper per candidate, ~100× faster.
 */
export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  let body: {
    seedUrl?: string;
    candidateUrls?: string[];
    topK?: number;
    minSimilarity?: number;
    taskId?: string;
    keyword?: string;
  };
  try { body = await req.json(); } catch { body = {}; }

  if (!body.seedUrl) return NextResponse.json({ error: 'seedUrl required' }, { status: 400 });
  if (!Array.isArray(body.candidateUrls) || body.candidateUrls.length === 0) {
    return NextResponse.json({ error: 'candidateUrls array required' }, { status: 400 });
  }

  try {
    const result = await expandFromSeed({
      seedUrl: body.seedUrl,
      candidateUrls: body.candidateUrls,
      topK: body.topK,
      minSimilarity: body.minSimilarity,
      taskId: body.taskId,
      keyword: body.keyword,
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message?.slice(0, 500) || 'unknown' },
      { status: 500 },
    );
  }
}
