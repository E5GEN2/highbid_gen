import { NextRequest, NextResponse } from 'next/server';
import { refreshClipViewCounts } from '@/lib/yt-clip-views';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

/**
 * POST /api/admin/vizard/clips/refresh-views
 *
 * Refreshes YT view/like/comment counts for uploaded clips via the YT
 * Data API. Costs 1 quota unit per 50 clips (videos.list batches them).
 *
 * Body (all optional):
 *   { clipIds?: number[], force?: boolean, staleMinutes?: number }
 *     clipIds      — refresh only these specific clips (default: all uploaded)
 *     force        — bypass the staleness gate; refresh even recently-fetched rows
 *     staleMinutes — only refresh rows older than this when not in force mode
 *                    (default 60)
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({})) as {
    clipIds?: number[];
    force?: boolean;
    staleMinutes?: number;
  };
  const result = await refreshClipViewCounts({
    clipIds: body.clipIds,
    force: body.force,
    staleMinutes: body.staleMinutes,
  });
  if (!result.ok) {
    return NextResponse.json(result, { status: 400 });
  }
  return NextResponse.json(result);
}
