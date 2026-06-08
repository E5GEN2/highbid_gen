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
  if (!rel || rel.includes('/') || rel.includes('\\') || rel.includes('..')) {
    return NextResponse.json({ error: 'bad path' }, { status: 400 });
  }
  const full = path.join(RENDER_DIR, rel);
  let stat;
  try { stat = statSync(full); }
  catch { return NextResponse.json({ error: 'not found' }, { status: 404 }); }

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
      'Content-Type': 'video/mp4',
      'Content-Length': String(stat.size),
      'Cache-Control': 'no-store',
    },
  });
}
