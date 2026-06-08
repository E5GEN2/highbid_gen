/**
 * GET /api/admin/content-gen/producer/file?path=job-N-TIMESTAMP.mp4
 *
 * Serves a rendered mp4 from CLIPS_DIR/producer_renders. Path is constrained
 * to a basename inside that dir to prevent traversal.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createReadStream, statSync } from 'fs';
import path from 'path';
import { isAdmin } from '@/lib/admin-auth';
import { CLIPS_DIR } from '@/lib/clips-dir';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const RENDER_DIR = path.join(CLIPS_DIR, 'producer_renders');

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const rel = req.nextUrl.searchParams.get('path');
  if (!rel || rel.includes('..') || rel.startsWith('/') || rel.includes('\\')) {
    return NextResponse.json({ error: 'bad path' }, { status: 400 });
  }
  // Allow nested frames/job-N/frame_NN.png paths under RENDER_DIR.
  // Realpath check guards against any symlink-based traversal sneaking in.
  const full = path.join(RENDER_DIR, rel);
  if (!full.startsWith(RENDER_DIR + path.sep)) {
    return NextResponse.json({ error: 'bad path' }, { status: 400 });
  }
  let stat;
  try { stat = statSync(full); }
  catch { return NextResponse.json({ error: 'not found' }, { status: 404 }); }
  // Content-type for image frames.
  const ext = path.extname(full).toLowerCase();
  const contentType = ext === '.png' ? 'image/png'
    : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : 'video/mp4';

  const stream = createReadStream(full);
  // Convert Node stream → web ReadableStream for NextResponse
  const webStream = new ReadableStream({
    start(controller) {
      stream.on('data', (chunk: Buffer | string) => controller.enqueue(chunk instanceof Buffer ? chunk : Buffer.from(chunk)));
      stream.on('end', () => controller.close());
      stream.on('error', e => controller.error(e));
    },
    cancel() { stream.destroy(); },
  });
  return new NextResponse(webStream, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-store',
    },
  });
}
