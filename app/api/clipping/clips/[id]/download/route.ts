import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import fs from 'fs';

/**
 * GET /api/clipping/clips/[id]/download
 * Stream the clip MP4 file.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const result = await pool.query(
    `SELECT c.file_path, c.title, c.duration_sec, c.file_size_bytes
     FROM clipping_clips c
     WHERE c.id = $1 AND c.status = 'done'`,
    [id]
  );

  if (result.rows.length === 0) {
    return NextResponse.json({ error: 'Clip not found or not ready' }, { status: 404 });
  }

  const clip = result.rows[0];
  if (!clip.file_path || !fs.existsSync(clip.file_path)) {
    return NextResponse.json({ error: 'Clip file not found on disk' }, { status: 404 });
  }

  const fileBuffer = fs.readFileSync(clip.file_path);
  const safeName = clip.title.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 80);

  return new Response(fileBuffer, {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': String(fileBuffer.length),
      'Content-Disposition': `attachment; filename="${safeName}.mp4"`,
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
