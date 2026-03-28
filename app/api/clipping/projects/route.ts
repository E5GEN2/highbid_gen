import { NextRequest, NextResponse } from 'next/server';
import { getApiUser } from '@/lib/api-auth';
import { pool } from '@/lib/db';

// List clipping projects for the current user
export async function GET(req: NextRequest) {
  const user = await getApiUser(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await pool.query(
    `SELECT id, title, status, thumbnail_url, video_duration, created_at, updated_at
     FROM clipping_projects
     WHERE user_id = $1
     ORDER BY updated_at DESC`,
    [user.id]
  );

  return NextResponse.json({ projects: result.rows });
}

// Create a new clipping project
export async function POST(req: NextRequest) {
  const user = await getApiUser(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { title } = await req.json();

  const result = await pool.query(
    `INSERT INTO clipping_projects (user_id, title)
     VALUES ($1, $2)
     RETURNING id, title, status, thumbnail_url, video_duration, created_at, updated_at`,
    [user.id, title || 'Untitled']
  );

  return NextResponse.json({ project: result.rows[0] });
}
