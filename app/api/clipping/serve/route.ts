import { NextRequest, NextResponse } from 'next/server';
import { getApiUser } from '@/lib/api-auth';
import { pool } from '@/lib/db';
import fs from 'fs';

/**
 * GET /api/clipping/serve?clipId=xxx[&type=video|thumbnail]
 * Serve a clip video or thumbnail file. Requires auth.
 */
export async function GET(req: NextRequest) {
  const user = await getApiUser(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const clipId = req.nextUrl.searchParams.get('clipId');
  const type = req.nextUrl.searchParams.get('type') || 'video';

  if (!clipId) {
    return NextResponse.json({ error: 'clipId required' }, { status: 400 });
  }

  // Get clip and verify ownership
  const result = await pool.query(
    `SELECT c.file_path, c.thumbnail_path, c.title, p.user_id
     FROM clipping_clips c
     JOIN clipping_projects p ON c.project_id = p.id
     WHERE c.id = $1`,
    [clipId]
  );

  if (result.rows.length === 0) {
    return NextResponse.json({ error: 'Clip not found' }, { status: 404 });
  }

  const clip = result.rows[0];
  if (clip.user_id !== user.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
  }

  const filePath = type === 'thumbnail' ? clip.thumbnail_path : clip.file_path;
  if (!filePath || !fs.existsSync(filePath)) {
    return NextResponse.json({ error: 'File not found on disk' }, { status: 404 });
  }

  const buffer = fs.readFileSync(filePath);
  const contentType = type === 'thumbnail' ? 'image/jpeg' : 'video/mp4';
  const filename = type === 'thumbnail'
    ? `${clip.title || 'thumbnail'}.jpg`
    : `${clip.title || 'clip'}.mp4`;

  return new Response(buffer, {
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(buffer.length),
      'Content-Disposition': `inline; filename="${filename}"`,
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
