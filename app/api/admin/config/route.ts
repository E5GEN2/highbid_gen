import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../lib/db';

// GET all config values
export async function GET() {
  try {
    const pool = await getPool();
    const result = await pool.query('SELECT key, value FROM admin_config');
    const config: Record<string, string> = {};
    for (const row of result.rows) {
      config[row.key] = row.value;
    }
    return NextResponse.json({ success: true, config });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to load config' },
      { status: 500 }
    );
  }
}

// POST to upsert config values
export async function POST(req: NextRequest) {
  try {
    const { config } = await req.json() as { config: Record<string, string> };
    const pool = await getPool();

    for (const [key, value] of Object.entries(config)) {
      await pool.query(
        `INSERT INTO admin_config (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
        [key, value]
      );
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to save config' },
      { status: 500 }
    );
  }
}
