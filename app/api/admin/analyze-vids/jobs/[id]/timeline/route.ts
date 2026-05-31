import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';

/**
 * GET /api/admin/analyze-vids/jobs/[id]/timeline
 *
 * Serve the collapsed per-video timeline as a downloadable JSON file.
 * Defaults to attachment disposition so the admin "Download timeline"
 * button just works; pass ?inline=1 to view in browser.
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const { id } = await ctx.params;
  const jobId = parseInt(id);
  if (!Number.isFinite(jobId)) return NextResponse.json({ error: 'invalid job id' }, { status: 400 });

  const pool = await getPool();
  const r = await pool.query<{
    timeline_jsonb: Record<string, unknown> | null;
    source_video_title: string | null;
    status: string;
  }>(
    `SELECT timeline_jsonb, source_video_title, status
       FROM video_analysis_jobs WHERE id = $1`,
    [jobId],
  );
  if (r.rows.length === 0) return NextResponse.json({ error: 'job not found' }, { status: 404 });
  if (!r.rows[0].timeline_jsonb) {
    return NextResponse.json(
      { error: `no timeline yet — job is in status=${r.rows[0].status}` },
      { status: 409 },
    );
  }

  const inline = req.nextUrl.searchParams.get('inline') === '1';
  const safeName = (r.rows[0].source_video_title ?? `job-${jobId}`)
    .replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80) || `job-${jobId}`;
  const disposition = inline ? 'inline' : `attachment; filename="${safeName}.timeline.json"`;

  return new NextResponse(JSON.stringify(r.rows[0].timeline_jsonb, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': disposition,
    },
  });
}
