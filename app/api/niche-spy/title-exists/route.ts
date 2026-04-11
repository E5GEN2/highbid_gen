import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

/**
 * POST /api/niche-spy/title-exists
 * Check if a video title already exists (case-insensitive, trimmed).
 * Admin-level API — requires admin cookie or x-admin-token header.
 * Body: { "title": "How to lose weight fast" }
 */
export async function POST(req: NextRequest) {
  // Admin auth
  const cookies = req.headers.get('cookie') || '';
  const adminToken = cookies.match(/admin_token=([^;]+)/)?.[1];
  const headerToken = req.headers.get('x-admin-token');
  const token = adminToken || headerToken;

  if (!token) return NextResponse.json({ error: 'Admin access required', exists: false }, { status: 403 });
  try {
    const decoded = Buffer.from(token, 'base64').toString();
    if (!decoded.includes('rofe_admin_secret')) return NextResponse.json({ error: 'Invalid admin token', exists: false }, { status: 403 });
  } catch { return NextResponse.json({ error: 'Invalid admin token', exists: false }, { status: 403 }); }

  const body = await req.json().catch(() => ({}));
  const title = (body.title || '').trim();
  if (!title) return NextResponse.json({ error: 'title required', exists: false }, { status: 400 });

  try {
    const pool = await getPool();
    const result = await pool.query(
      'SELECT 1 FROM niche_spy_videos WHERE LOWER(TRIM(title)) = LOWER($1) LIMIT 1',
      [title]
    );
    return NextResponse.json({ exists: result.rows.length > 0 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Query failed', exists: false }, { status: 500 });
  }
}
