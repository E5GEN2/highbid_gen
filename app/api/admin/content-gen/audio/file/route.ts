import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { readAudioBedFile } from '@/lib/content-gen/audio-bed';

/** GET /api/admin/content-gen/audio/file?hash=… — serve a composed audio bed off the volume. */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const hash = req.nextUrl.searchParams.get('hash');
  if (!hash) return NextResponse.json({ error: 'hash required' }, { status: 400 });
  const file = await readAudioBedFile(hash);
  if (!file) return NextResponse.json({ error: 'not found' }, { status: 404 });
  return new Response(new Uint8Array(file.buf), {
    headers: {
      'Content-Type': file.contentType,
      'Content-Length': String(file.buf.length),
      'Cache-Control': 'public, max-age=86400',
      'Accept-Ranges': 'bytes',
    },
  });
}
