import { NextResponse } from 'next/server';
import { getPool } from '../../../lib/db';

export async function GET() {
  try {
    const pool = await getPool();

    const result = await pool.query(
      `SELECT id, title, thumbnail, updated_at
       FROM projects
       ORDER BY updated_at DESC`
    );

    const projects = result.rows.map(row => ({
      id: row.id,
      title: row.title,
      thumbnail: row.thumbnail,
      updatedAt: row.updated_at
    }));

    return NextResponse.json({
      success: true,
      projects
    });
  } catch (error) {
    console.error('Error listing projects:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to list projects' },
      { status: 500 }
    );
  }
}
