import { NextRequest, NextResponse } from 'next/server';
import { pool } from '@/lib/db';
import fs from 'fs';

/**
 * GET /api/clipping/clips/[id]/thumbnail
 * Serve the clip thumbnail JPG.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const result = await pool.query(
    `SELECT thumbnail_path FROM clipping_clips WHERE id = $1 AND status = 'done'`,
    [id]
  );

  if (result.rows.length === 0) {
    return NextResponse.json({ error: 'Clip not found' }, { status: 404 });
  }

  const thumbPath = result.rows[0].thumbnail_path;
  if (!thumbPath || !fs.existsSync(thumbPath)) {
    // Return a 1x1 transparent pixel as fallback
    const pixel = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
    return new Response(pixel, {
      headers: { 'Content-Type': 'image/gif', 'Cache-Control': 'public, max-age=60' },
    });
  }

  const fileBuffer = fs.readFileSync(thumbPath);
  return new Response(fileBuffer, {
    headers: {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(fileBuffer.length),
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
