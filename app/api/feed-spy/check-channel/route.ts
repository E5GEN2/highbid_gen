import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../lib/db';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'x-api-key',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

export async function GET(req: NextRequest) {
  try {
    // Auth: check x-api-key against admin_config
    const apiKey = req.headers.get('x-api-key');
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing x-api-key header' }, { status: 401, headers: corsHeaders });
    }

    const pool = await getPool();

    const configResult = await pool.query(
      `SELECT value FROM admin_config WHERE key = 'channel_check_api_key'`
    );
    const storedKey = configResult.rows[0]?.value;

    if (!storedKey || apiKey !== storedKey) {
      return NextResponse.json({ error: 'Invalid API key' }, { status: 401, headers: corsHeaders });
    }

    // Validate handle param
    const handle = req.nextUrl.searchParams.get('handle');
    if (!handle) {
      return NextResponse.json({ error: 'Missing handle query parameter' }, { status: 400, headers: corsHeaders });
    }

    // Check if channel exists by URL pattern or channel_id
    const result = await pool.query(
      `SELECT 1 FROM shorts_channels WHERE channel_url LIKE $1 OR channel_id = $2 LIMIT 1`,
      [`%/@${handle}%`, `@${handle}`]
    );

    return NextResponse.json({ known: result.rows.length > 0 }, { headers: corsHeaders });
  } catch (err) {
    console.error('check-channel error:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders });
  }
}
