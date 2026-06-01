import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { getPool } from '@/lib/db';
import { createReadStream } from 'fs';
import { stat } from 'fs/promises';
import path from 'path';
import { XG_VIDEOS_DIR } from '@/lib/xg-videos-dir';

/**
 * GET /api/admin/xg-vid-download/[id]/file
 *
 * Stream the downloaded mp4 back to the admin so the operator can
 * preview it without SSHing into the Railway box. Path comes straight
 * from xg_video_downloads.local_path — verified to live under
 * XG_VIDEOS_DIR before we open it (defense in depth in case the DB
 * field ever gets manually edited).
 */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });

  const { id } = await ctx.params;
  const rowId = parseInt(id);
  if (!Number.isFinite(rowId)) return NextResponse.json({ error: 'invalid id' }, { status: 400 });

  const pool = await getPool();
  const r = await pool.query<{ local_path: string | null; uploaded_url: string | null }>(
    `SELECT local_path, uploaded_url FROM xg_video_downloads WHERE id = $1`,
    [rowId],
  );
  if (r.rows.length === 0) return NextResponse.json({ error: 'not found' }, { status: 404 });
  const localPath = r.rows[0].local_path;
  if (!localPath) {
    return NextResponse.json({ error: 'no local file yet', uploadedUrl: r.rows[0].uploaded_url }, { status: 404 });
  }

  // Containment check — refuse to serve anything outside XG_VIDEOS_DIR
  // even if the column was somehow set to /etc/passwd.
  const absDir = path.resolve(XG_VIDEOS_DIR);
  const absPath = path.resolve(localPath);
  if (!absPath.startsWith(absDir + path.sep) && absPath !== absDir) {
    return NextResponse.json({ error: 'path outside store' }, { status: 403 });
  }

  try {
    const st = await stat(absPath);
    const stream = createReadStream(absPath);
    // Streams to ReadableStream — Next 15 accepts NodeJS.ReadableStream
    // via the Response constructor's web-stream adapter. Keeps memory
    // flat for large mp4s instead of buffering the whole file.
    return new Response(stream as unknown as ReadableStream, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Length': String(st.size),
        'Content-Disposition': `inline; filename="${path.basename(absPath)}"`,
        'Cache-Control': 'private, max-age=60',
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'file read failed', detail: (err as Error).message?.slice(0, 200) },
      { status: 500 },
    );
  }
}
