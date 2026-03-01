import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../../lib/db';
import { executeAutoPost } from '../../../../../lib/autoPost';

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get('admin_token')?.value;
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, 'base64').toString();
    return decoded.startsWith('admin:') && decoded.endsWith(':rofe_admin_secret');
  } catch {
    return false;
  }
}

async function saveConfig(pool: import('pg').Pool, entries: Record<string, string>) {
  for (const [key, value] of Object.entries(entries)) {
    await pool.query(
      `INSERT INTO admin_config (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value]
    );
  }
}

// GET: fetch auto-post config + logs
export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const pool = await getPool();
  const result = await pool.query(
    `SELECT key, value FROM admin_config WHERE key IN (
      'auto_post_enabled', 'auto_post_interval_hours',
      'x_api_key', 'x_api_secret', 'x_access_token', 'x_access_token_secret',
      'last_auto_post_at', 'last_auto_post_result', 'cron_secret'
    )`
  );
  const config: Record<string, string> = {};
  for (const row of result.rows) config[row.key] = row.value;

  // Return previews for secrets, not full values
  const preview = (val: string | undefined) =>
    val ? `${val.slice(0, 6)}...${val.slice(-4)}` : null;

  let lastPostResult = null;
  try {
    if (config.last_auto_post_result) {
      lastPostResult = JSON.parse(config.last_auto_post_result);
    }
  } catch {}

  return NextResponse.json({
    enabled: config.auto_post_enabled === 'true',
    intervalHours: parseInt(config.auto_post_interval_hours) || 24,
    hasCronSecret: !!config.cron_secret,
    credentials: {
      apiKey: preview(config.x_api_key),
      apiSecret: preview(config.x_api_secret),
      accessToken: preview(config.x_access_token),
      accessTokenSecret: preview(config.x_access_token_secret),
    },
    lastPostAt: config.last_auto_post_at || null,
    lastPostResult,
  });
}

// POST: save config or trigger manual post
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const pool = await getPool();
  const body = await req.json();

  // Save credentials
  if (body.credentials) {
    const entries: Record<string, string> = {};
    if (body.credentials.apiKey) entries.x_api_key = body.credentials.apiKey;
    if (body.credentials.apiSecret) entries.x_api_secret = body.credentials.apiSecret;
    if (body.credentials.accessToken) entries.x_access_token = body.credentials.accessToken;
    if (body.credentials.accessTokenSecret) entries.x_access_token_secret = body.credentials.accessTokenSecret;
    await saveConfig(pool, entries);
    return NextResponse.json({ success: true });
  }

  // Toggle enabled
  if (body.enabled !== undefined) {
    await saveConfig(pool, { auto_post_enabled: body.enabled ? 'true' : 'false' });
    return NextResponse.json({ success: true });
  }

  // Set interval hours
  if (body.intervalHours !== undefined) {
    await saveConfig(pool, { auto_post_interval_hours: String(body.intervalHours) });
    return NextResponse.json({ success: true });
  }

  // Post now: execute directly (no cron route, no guards)
  if (body.postNow) {
    const result = await executeAutoPost(pool);
    return NextResponse.json(result);
  }

  return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
}
