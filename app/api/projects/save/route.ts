import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../lib/db';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { id, title, thumbnail, projectData } = body;

    if (!id || !title || !projectData) {
      return NextResponse.json(
        { error: 'Missing required fields: id, title, projectData' },
        { status: 400 }
      );
    }

    const pool = await getPool();

    // Upsert - insert or update on conflict
    await pool.query(
      `INSERT INTO projects (id, title, thumbnail, project_data, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (id) DO UPDATE SET
         title = EXCLUDED.title,
         thumbnail = EXCLUDED.thumbnail,
         project_data = EXCLUDED.project_data,
         updated_at = NOW()`,
      [id, title, thumbnail || null, JSON.stringify(projectData)]
    );

    return NextResponse.json({
      success: true,
      id,
      message: 'Project saved successfully'
    });
  } catch (error) {
    console.error('Error saving project:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to save project' },
      { status: 500 }
    );
  }
}
