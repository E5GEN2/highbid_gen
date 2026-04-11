import { TwitterApi } from 'twitter-api-v2';
import { ProxyAgent, fetch as proxyFetch } from 'undici';
import type { Pool } from 'pg';

const SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'];
const TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const API_BASE = 'https://api.x.com/2';

// ─── Proxy-aware fetch ───────────────────────────────────────────────
// All Twitter API calls go through TWITTER_PROXY_URL if set (residential proxy
// bypasses Railway IP block on Twitter Free tier)

function getDispatcher(): ProxyAgent | undefined {
  const url = process.env.TWITTER_PROXY_URL;
  if (!url) return undefined;
  return new ProxyAgent(url);
}

/** Proxied fetch with retry on 503 */
async function twitterFetch(url: string, init: Record<string, unknown> = {}, maxRetries = 3): Promise<Response> {
  const dispatcher = getDispatcher();
  const opts = { ...init, ...(dispatcher ? { dispatcher } : {}) };

  let lastRes: Response | undefined;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Use undici fetch if proxy is configured, otherwise global fetch
    lastRes = dispatcher
      ? await proxyFetch(url, opts as Parameters<typeof proxyFetch>[1]) as unknown as Response
      : await fetch(url, init as RequestInit);
    if (lastRes.status !== 503 || attempt === maxRetries) return lastRes;
    await new Promise(r => setTimeout(r, 2000 * Math.pow(2, attempt - 1)));
  }
  return lastRes!;
}

// ─── DB helpers ──────────────────────────────────────────────────────

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

// ─── OAuth config (for curl fallback page) ───────────────────────────

export async function getOAuthConfig(pool: Pool) {
  const cfg = await getConfig(pool, [
    'x_client_id', 'x_client_secret',
    'x_oauth2_code_verifier', 'x_oauth2_callback_url',
  ]);
  return {
    clientId: cfg.x_client_id || '',
    clientSecret: cfg.x_client_secret || '',
    codeVerifier: cfg.x_oauth2_code_verifier || '',
    callbackUrl: cfg.x_oauth2_callback_url || '',
  };
}

// ─── Auth link generation (uses library — no network call, just URL building) ─

export async function generateAuthLink(pool: Pool, callbackUrl: string): Promise<string> {
  const cfg = await getConfig(pool, ['x_client_id', 'x_client_secret']);
  if (!cfg.x_client_id) throw new Error('x_client_id not configured');

  const client = new TwitterApi({ clientId: cfg.x_client_id, clientSecret: cfg.x_client_secret });
  const { url, codeVerifier, state } = client.generateOAuth2AuthLink(callbackUrl, {
    scope: SCOPES,
  });

  await saveConfig(pool, {
    x_oauth2_code_verifier: codeVerifier,
    x_oauth2_state: state,
    x_oauth2_callback_url: callbackUrl,
  });

  return url;
}

// ─── Token exchange (direct fetch through proxy) ─────────────────────

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

  const tokenRes = await twitterFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: cfg.x_client_id,
      code,
      redirect_uri: cfg.x_oauth2_callback_url,
      code_verifier: cfg.x_oauth2_code_verifier,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Token exchange ${tokenRes.status}: ${text}`);
  }

  const tokenData = await tokenRes.json() as { access_token: string; refresh_token?: string };
  if (!tokenData.refresh_token) throw new Error('No refresh token — offline.access scope required');

  // Get username via proxy
  const meRes = await twitterFetch(`${API_BASE}/users/me`, {
    headers: { Authorization: `Bearer ${tokenData.access_token}` },
  });
  let username = 'connected';
  if (meRes.ok) {
    const meData = await meRes.json() as { data: { username: string } };
    username = meData.data.username;
  }

  await saveConfig(pool, {
    x_oauth2_access_token: tokenData.access_token,
    x_oauth2_refresh_token: tokenData.refresh_token,
    x_oauth2_username: username,
  });

  await pool.query(`DELETE FROM admin_config WHERE key IN ('x_oauth2_code_verifier', 'x_oauth2_state')`);
  return { username };
}

// ─── Save tokens manually (from curl fallback) ──────────────────────

export async function saveTokensManually(
  pool: Pool,
  accessToken: string,
  refreshToken: string
): Promise<{ username: string }> {
  // Try to get username through proxy
  let username = 'connected';
  try {
    const meRes = await twitterFetch(`${API_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (meRes.ok) {
      const meData = await meRes.json() as { data: { username: string } };
      username = meData.data.username;
    }
  } catch {
    // Proxy might not be configured yet — save tokens anyway
  }

  await saveConfig(pool, {
    x_oauth2_access_token: accessToken,
    x_oauth2_refresh_token: refreshToken,
    x_oauth2_username: username,
  });

  await pool.query(`DELETE FROM admin_config WHERE key IN ('x_oauth2_code_verifier', 'x_oauth2_state')`);
  return { username };
}

// ─── Authed client (refresh token + return accessToken) ──────────────

export async function getAuthedClient(pool: Pool): Promise<{ accessToken: string; username: string } | null> {
  const cfg = await getConfig(pool, [
    'x_client_id', 'x_client_secret',
    'x_oauth2_refresh_token', 'x_oauth2_username',
  ]);

  if (!cfg.x_client_id || !cfg.x_oauth2_refresh_token) return null;

  const tokenRes = await twitterFetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: cfg.x_client_id,
      refresh_token: cfg.x_oauth2_refresh_token,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Token refresh ${tokenRes.status}: ${text}`);
  }

  const tokenData = await tokenRes.json() as { access_token: string; refresh_token?: string };

  const updates: Record<string, string> = { x_oauth2_access_token: tokenData.access_token };
  if (tokenData.refresh_token) updates.x_oauth2_refresh_token = tokenData.refresh_token;
  await saveConfig(pool, updates);

  return {
    accessToken: tokenData.access_token,
    username: cfg.x_oauth2_username || 'unknown',
  };
}

// ─── Post thread (direct fetch through proxy) ────────────────────────

export interface PostThreadResult {
  tweetIds: string[];
  threadUrl: string | null;
  error?: string;
}

export async function postThread(
  accessToken: string,
  tweets: { text: string }[]
): Promise<PostThreadResult> {
  const tweetIds: string[] = [];
  let error: string | undefined;

  try {
    for (let i = 0; i < tweets.length; i++) {
      const body: Record<string, unknown> = { text: tweets[i].text };
      if (i > 0) {
        body.reply = { in_reply_to_tweet_id: tweetIds[i - 1] };
      }

      const res = await twitterFetch(`${API_BASE}/tweets`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Tweet ${res.status}: ${text}`);
      }

      const data = await res.json() as { data: { id: string } };
      tweetIds.push(data.data.id);
    }
  } catch (err: unknown) {
    error = err instanceof Error ? err.message : String(err);
  }

  const threadUrl = tweetIds.length > 0
    ? `https://x.com/i/status/${tweetIds[0]}`
    : null;

  return { tweetIds, threadUrl, error };
}
