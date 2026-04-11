import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '@/lib/db';
import { isAdmin } from '@/lib/admin-auth';

/**
 * POST /api/niche-spy/title-exists
 * Check if a video title already exists (case-insensitive, trimmed).
 * Admin-level API.
 * Body: { "title": "How to lose weight fast" }
 */
export async function POST(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required', exists: false }, { status: 403 });

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
