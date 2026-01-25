import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../lib/db';

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;
    const pool = await getPool();

    const result = await pool.query(
      `SELECT id, title, thumbnail, project_data, created_at, updated_at
       FROM projects
       WHERE id = $1`,
      [projectId]
    );

    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    const row = result.rows[0];
    return NextResponse.json({
      success: true,
      project: {
        id: row.id,
        title: row.title,
        thumbnail: row.thumbnail,
        projectData: row.project_data,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }
    });
  } catch (error) {
    console.error('Error loading project:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load project' },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  try {
    const { projectId } = await params;
    const pool = await getPool();

    const result = await pool.query(
      `DELETE FROM projects WHERE id = $1 RETURNING id`,
      [projectId]
    );

    if (result.rows.length === 0) {
      return NextResponse.json(
        { error: 'Project not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      message: 'Project deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting project:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to delete project' },
      { status: 500 }
    );
  }
}
