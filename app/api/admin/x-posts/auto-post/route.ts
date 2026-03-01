import { NextRequest, NextResponse } from 'next/server';
import { getPool } from '../../../../../lib/db';
import { executeAutoPost } from '../../../../../lib/autoPost';
import { generateAuthLink } from '../../../../../lib/twitter';

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

// GET: fetch auto-post config
export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const pool = await getPool();
  const result = await pool.query(
    `SELECT key, value FROM admin_config WHERE key IN (
      'auto_post_enabled', 'auto_post_interval_hours',
      'x_client_id', 'x_client_secret',
      'x_oauth2_username', 'x_oauth2_refresh_token',
      'last_auto_post_at', 'last_auto_post_result', 'cron_secret'
    )`
  );
  const config: Record<string, string> = {};
  for (const row of result.rows) config[row.key] = row.value;

  let lastPostResult = null;
  try {
    if (config.last_auto_post_result) lastPostResult = JSON.parse(config.last_auto_post_result);
  } catch {}

  return NextResponse.json({
    enabled: config.auto_post_enabled === 'true',
    intervalHours: parseInt(config.auto_post_interval_hours) || 24,
    hasCronSecret: !!config.cron_secret,
    hasClientId: !!config.x_client_id,
    hasClientSecret: !!config.x_client_secret,
    connectedUsername: config.x_oauth2_username || null,
    isConnected: !!config.x_oauth2_refresh_token,
    lastPostAt: config.last_auto_post_at || null,
    lastPostResult,
  });
}

// POST: save config, connect, or trigger post
export async function POST(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const pool = await getPool();
  const body = await req.json();

  // Save client credentials
  if (body.clientCredentials) {
    const entries: Record<string, string> = {};
    if (body.clientCredentials.clientId) entries.x_client_id = body.clientCredentials.clientId;
    if (body.clientCredentials.clientSecret) entries.x_client_secret = body.clientCredentials.clientSecret;
    await saveConfig(pool, entries);
    return NextResponse.json({ success: true });
  }

  // Generate OAuth 2.0 auth link
  if (body.connect) {
    try {
      const host = req.headers.get('host') || 'rofe.ai';
      const protocol = host.includes('localhost') ? 'http' : 'https';
      const callbackUrl = `${protocol}://${host}/api/admin/x-posts/auto-post/callback`;
      const authUrl = await generateAuthLink(pool, callbackUrl);
      return NextResponse.json({ success: true, authUrl });
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Failed to generate auth link' }, { status: 400 });
    }
  }

  // Disconnect
  if (body.disconnect) {
    await pool.query(`DELETE FROM admin_config WHERE key IN ('x_oauth2_access_token', 'x_oauth2_refresh_token', 'x_oauth2_username')`);
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

  // Post now
  if (body.postNow) {
    const result = await executeAutoPost(pool);
    return NextResponse.json(result);
  }

  return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
}
