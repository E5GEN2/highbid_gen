import { TwitterApi } from 'twitter-api-v2';
import type { Pool } from 'pg';

export interface TwitterCredentials {
  appKey: string;
  appSecret: string;
  accessToken: string;
  accessSecret: string;
}

export async function getTwitterCredentials(pool: Pool): Promise<TwitterCredentials | null> {
  const result = await pool.query(
    `SELECT key, value FROM admin_config WHERE key IN ('x_api_key', 'x_api_secret', 'x_access_token', 'x_access_token_secret')`
  );
  const cfg: Record<string, string> = {};
  for (const row of result.rows) cfg[row.key] = row.value;

  if (!cfg.x_api_key || !cfg.x_api_secret || !cfg.x_access_token || !cfg.x_access_token_secret) {
    return null;
  }

  return {
    appKey: cfg.x_api_key,
    appSecret: cfg.x_api_secret,
    accessToken: cfg.x_access_token,
    accessSecret: cfg.x_access_token_secret,
  };
}

export function createTwitterClient(creds: TwitterCredentials): TwitterApi {
  return new TwitterApi({
    appKey: creds.appKey,
    appSecret: creds.appSecret,
    accessToken: creds.accessToken,
    accessSecret: creds.accessSecret,
  });
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
    // Post first tweet
    const first = await client.v2.tweet(tweets[0].text);
    tweetIds.push(first.data.id);

    // Post replies chained to previous tweet
    for (let i = 1; i < tweets.length; i++) {
      const reply = await client.v2.reply(tweets[i].text, tweetIds[i - 1]);
      tweetIds.push(reply.data.id);
    }
  } catch (err: unknown) {
    // Dump all available error info for debugging
    const parts: string[] = [];
    if (err instanceof Error) {
      parts.push(err.message);
      if ('code' in err) parts.push(`code: ${(err as Record<string, unknown>).code}`);
      if ('data' in err) parts.push(`data: ${JSON.stringify((err as Record<string, unknown>).data)}`);
      if ('errors' in err) parts.push(`errors: ${JSON.stringify((err as Record<string, unknown>).errors)}`);
      if ('rateLimit' in err) parts.push(`rateLimit: ${JSON.stringify((err as Record<string, unknown>).rateLimit)}`);
      // Check for response body
      if ('body' in err) parts.push(`body: ${JSON.stringify((err as Record<string, unknown>).body)}`);
    } else {
      parts.push(String(err));
    }
    // Also try to get all enumerable keys
    if (err && typeof err === 'object') {
      const keys = Object.keys(err).filter(k => !['message', 'stack'].includes(k));
      if (keys.length > 0) {
        const extra: Record<string, unknown> = {};
        for (const k of keys) extra[k] = (err as Record<string, unknown>)[k];
        parts.push(`raw: ${JSON.stringify(extra)}`);
      }
    }
    error = parts.join(' | ');
  }

  const threadUrl = tweetIds.length > 0
    ? `https://x.com/i/status/${tweetIds[0]}`
    : null;

  return { tweetIds, threadUrl, error };
}
