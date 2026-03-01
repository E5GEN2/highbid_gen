import { TwitterApi } from 'twitter-api-v2';
import type { Pool } from 'pg';

const SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'];

async function getConfig(pool: Pool, keys: string[]): Promise<Record<string, string>> {
  const result = await pool.query(
    `SELECT key, value FROM admin_config WHERE key = ANY($1)`,
    [keys]
  );
  const cfg: Record<string, string> = {};
  for (const row of result.rows) cfg[row.key] = row.value;
  return cfg;
}

async function saveConfig(pool: Pool, entries: Record<string, string>) {
  for (const [key, value] of Object.entries(entries)) {
    await pool.query(
      `INSERT INTO admin_config (key, value, updated_at) VALUES ($1, $2, NOW())
       ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
      [key, value]
    );
  }
}

/**
 * Generate OAuth 2.0 PKCE authorization link.
 * Returns { url, codeVerifier, state } — store codeVerifier+state in admin_config.
 */
export async function generateAuthLink(pool: Pool, callbackUrl: string): Promise<string> {
  const cfg = await getConfig(pool, ['x_client_id', 'x_client_secret']);
  if (!cfg.x_client_id) throw new Error('x_client_id not configured');

  const client = new TwitterApi({ clientId: cfg.x_client_id, clientSecret: cfg.x_client_secret });
  const { url, codeVerifier, state } = client.generateOAuth2AuthLink(callbackUrl, {
    scope: SCOPES,
  });

  // Store codeVerifier and state for the callback
  await saveConfig(pool, {
    x_oauth2_code_verifier: codeVerifier,
    x_oauth2_state: state,
    x_oauth2_callback_url: callbackUrl,
  });

  return url;
}

/**
 * Handle OAuth 2.0 callback — exchange code for tokens.
 */
export async function handleOAuth2Callback(
  pool: Pool,
  code: string,
  state: string
): Promise<{ username: string }> {
  const cfg = await getConfig(pool, [
    'x_client_id', 'x_client_secret',
    'x_oauth2_code_verifier', 'x_oauth2_state', 'x_oauth2_callback_url',
  ]);

  if (!cfg.x_oauth2_state || state !== cfg.x_oauth2_state) {
    throw new Error('Invalid OAuth state');
  }

  // Direct fetch for token exchange — twitter-api-v2 library triggers 503 on Free tier
  const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${cfg.x_client_id}:${cfg.x_client_secret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: cfg.x_oauth2_callback_url,
      code_verifier: cfg.x_oauth2_code_verifier,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Request failed with code ${tokenRes.status}: ${text}`);
  }

  const tokenData = await tokenRes.json();
  const accessToken: string = tokenData.access_token;
  const refreshToken: string | undefined = tokenData.refresh_token;

  if (!refreshToken) throw new Error('No refresh token received — offline.access scope required');

  // Get username
  const loggedClient = new TwitterApi(accessToken);
  const me = await loggedClient.v2.me();

  // Store tokens
  await saveConfig(pool, {
    x_oauth2_access_token: accessToken,
    x_oauth2_refresh_token: refreshToken,
    x_oauth2_username: me.data.username,
  });

  // Clean up temporary OAuth state
  await pool.query(`DELETE FROM admin_config WHERE key IN ('x_oauth2_code_verifier', 'x_oauth2_state')`);

  return { username: me.data.username };
}

/**
 * Get an authenticated Twitter client using stored OAuth 2.0 refresh token.
 * Auto-refreshes the access token each time.
 */
export async function getAuthedClient(pool: Pool): Promise<{ client: TwitterApi; username: string } | null> {
  const cfg = await getConfig(pool, [
    'x_client_id', 'x_client_secret',
    'x_oauth2_refresh_token', 'x_oauth2_username',
  ]);

  if (!cfg.x_client_id || !cfg.x_oauth2_refresh_token) return null;

  // Direct fetch for token refresh — twitter-api-v2 library triggers 503 on Free tier
  const tokenRes = await fetch('https://api.twitter.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${cfg.x_client_id}:${cfg.x_client_secret}`).toString('base64')}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cfg.x_oauth2_refresh_token,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Token refresh failed with code ${tokenRes.status}: ${text}`);
  }

  const tokenData = await tokenRes.json();
  const accessToken: string = tokenData.access_token;
  const newRefreshToken: string | undefined = tokenData.refresh_token;

  // Store the new tokens (refresh tokens are single-use)
  const updates: Record<string, string> = { x_oauth2_access_token: accessToken };
  if (newRefreshToken) updates.x_oauth2_refresh_token = newRefreshToken;
  await saveConfig(pool, updates);

  return {
    client: new TwitterApi(accessToken),
    username: cfg.x_oauth2_username || 'unknown',
  };
}

export interface PostThreadResult {
  tweetIds: string[];
  threadUrl: string | null;
  error?: string;
}

export async function postThread(
  client: TwitterApi,
  tweets: { text: string }[]
): Promise<PostThreadResult> {
  const tweetIds: string[] = [];
  let error: string | undefined;

  try {
    const first = await client.v2.tweet(tweets[0].text);
    tweetIds.push(first.data.id);

    for (let i = 1; i < tweets.length; i++) {
      const reply = await client.v2.reply(tweets[i].text, tweetIds[i - 1]);
      tweetIds.push(reply.data.id);
    }
  } catch (err: unknown) {
    const parts: string[] = [];
    if (err instanceof Error) {
      parts.push(err.message);
      if ('code' in err) parts.push(`code: ${(err as Record<string, unknown>).code}`);
      if ('data' in err) parts.push(`data: ${JSON.stringify((err as Record<string, unknown>).data)}`);
    } else {
      parts.push(String(err));
    }
    error = parts.join(' | ');
  }

  const threadUrl = tweetIds.length > 0
    ? `https://x.com/i/status/${tweetIds[0]}`
    : null;

  return { tweetIds, threadUrl, error };
}
