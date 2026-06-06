import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { readImageFile } from '@/lib/xgodo-imagegen';

/** GET /api/admin/imagegen/file?id=123 — serve a downloaded image off the volume. */
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin token required' }, { status: 403 });
  const id = parseInt(req.nextUrl.searchParams.get('id') ?? '');
  if (!Number.isFinite(id)) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const file = await readImageFile(id);
  if (!file) return NextResponse.json({ error: 'not downloaded / not found' }, { status: 404 });

  return new Response(new Uint8Array(file.buf), {
    headers: {
      'Content-Type': file.contentType,
      'Content-Length': String(file.buf.length),
      'Content-Disposition': `inline; filename="imagegen-${id}${file.contentType.includes('png') ? '.png' : '.jpg'}"`,
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
