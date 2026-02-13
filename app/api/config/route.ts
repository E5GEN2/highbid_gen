import { NextResponse } from 'next/server';
import { getPool } from '../../../lib/db';

// Public endpoint — returns only safe config keys
export async function GET() {
  try {
    const pool = await getPool();
    const result = await pool.query(
      "SELECT value FROM admin_config WHERE key = 'visible_tabs'"
    );
    const raw = result.rows[0]?.value;
    let visibleTabs: string[] = ['feed']; // default: only feed
    try {
      if (raw) visibleTabs = JSON.parse(raw);
    } catch {}
    return NextResponse.json({ visibleTabs });
  } catch {
    return NextResponse.json({ visibleTabs: ['feed'] });
  }
}
