/**
 * Resolve YT-channel info for the gmails that uploaded our Vizard clips.
 *
 * Per the current xgodo setup, each (gmail account on a device) has
 * exactly one YouTube channel. So `account_email → channel_id → stats`
 * is a 1:1:1 chain we can populate by:
 *   1. picking any uploaded clip for the email (we have video_url)
 *   2. videos.list?part=snippet → channelId for that video
 *   3. channels.list?part=snippet,statistics → title + subscriber count
 *
 * Two API calls per refresh, each batched up to 50 ids — for 30 devices
 * with 1 channel each, that's ~2 quota units total.
 *
 * Reuses the same key + proxy pool as lib/yt-clip-views.ts so quota
 * accounting stays in one place.
 */

import { getPool } from './db';
import { getNextYtPair, banYtKey } from './yt-keys';
import { ytFetchViaProxy } from './yt-proxy-fetch';
import { extractYouTubeVideoId } from './yt-clip-views';

interface YtVideoSnippet {
  id?: string;
  snippet?: { channelId?: string; channelTitle?: string };
}

interface YtChannelItem {
  id?: string;
  snippet?: { title?: string; customUrl?: string };
  statistics?: { subscriberCount?: string; viewCount?: string; videoCount?: string };
}

export interface RefreshAccountsOpts {
  emails?: string[];        // restrict to these emails; otherwise all stale
  staleMinutes?: number;    // default 60 — skip refreshing recently-fetched
  force?: boolean;          // ignore staleness gate
}

export interface RefreshAccountsResult {
  ok: true;
  resolved: number;         // accounts with new channel_id
  updated: number;          // accounts with new stats
  errors: number;
  calls: number;
}

/**
 * Refresh channel + subscriber data for vizard_yt_accounts rows. Two phases:
 *   PHASE A — accounts with NULL channel_id: pick a representative video,
 *             call videos.list to discover the channelId, store it.
 *   PHASE B — every account that still needs stats (or is stale): call
 *             channels.list to fetch title + subscribers + views.
 */
export async function refreshVizardAccounts(
  opts: RefreshAccountsOpts = {},
): Promise<RefreshAccountsResult | { ok: false; error: string }> {
  const pool = await getPool();
  const stale = Math.max(1, opts.staleMinutes ?? 60);
  const force = !!opts.force;

  // ── PHASE A: resolve missing channel_ids ───────────────────────────
  const needChan = await pool.query<{ account_email: string }>(
    `SELECT a.account_email
       FROM vizard_yt_accounts a
       WHERE a.channel_id IS NULL
         ${opts.emails && opts.emails.length > 0 ? `AND a.account_email = ANY($1::text[])` : ''}`,
    opts.emails && opts.emails.length > 0 ? [opts.emails] : [],
  );

  let resolved = 0, updated = 0, errors = 0, calls = 0;

  if (needChan.rows.length > 0) {
    // For each email, pick one video_id from its uploaded clips.
    const emailToVideoId = new Map<string, string>();
    const videoIdToEmail = new Map<string, string>();
    for (const r of needChan.rows) {
      const clip = await pool.query<{ youtube_url: string | null; youtube_video_id: string | null }>(
        `SELECT youtube_url, youtube_video_id
           FROM vizard_clips
           WHERE xgodo_account_email = $1
             AND youtube_url IS NOT NULL
           ORDER BY xgodo_finished_at DESC NULLS LAST
           LIMIT 1`,
        [r.account_email],
      );
      const row = clip.rows[0];
      if (!row) continue;
      const vid = row.youtube_video_id || extractYouTubeVideoId(row.youtube_url);
      if (!vid) continue;
      emailToVideoId.set(r.account_email, vid);
      videoIdToEmail.set(vid, r.account_email);
    }

    const videoIds = [...emailToVideoId.values()];
    for (let i = 0; i < videoIds.length; i += 50) {
      const batch = videoIds.slice(i, i + 50);
      const pair = await getNextYtPair();
      if (!pair) return { ok: false, error: 'no YT API key configured' };

      const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet&id=${batch.join(',')}&key=${pair.key}`;
      const res = await ytFetchViaProxy(url, pair);
      calls++;
      if (!res.ok) {
        errors++;
        if (res.status === 429 || res.status === 403) banYtKey(pair.key);
        continue;
      }
      const data = res.data as { items?: YtVideoSnippet[] };
      for (const item of data.items || []) {
        const vid = item.id;
        const channelId = item.snippet?.channelId;
        const channelTitle = item.snippet?.channelTitle;
        if (!vid || !channelId) continue;
        const email = videoIdToEmail.get(vid);
        if (!email) continue;
        await pool.query(
          `UPDATE vizard_yt_accounts
             SET channel_id = $1, channel_title = COALESCE(channel_title, $2)
             WHERE account_email = $3`,
          [channelId, channelTitle || null, email],
        );
        resolved++;
      }
    }
  }

  // ── PHASE B: refresh channel stats ─────────────────────────────────
  const channelConditions: string[] = ['channel_id IS NOT NULL'];
  const channelParams: (string[] | null)[] = [];
  if (opts.emails && opts.emails.length > 0) {
    channelConditions.push(`account_email = ANY($${channelParams.length + 1}::text[])`);
    channelParams.push(opts.emails);
  } else if (!force) {
    channelConditions.push(`(fetched_at IS NULL OR fetched_at < NOW() - INTERVAL '${stale} minutes')`);
  }
  const accts = await pool.query<{ account_email: string; channel_id: string }>(
    `SELECT account_email, channel_id FROM vizard_yt_accounts
       WHERE ${channelConditions.join(' AND ')}`,
    channelParams,
  );
  if (accts.rows.length === 0) {
    return { ok: true, resolved, updated, errors, calls };
  }

  // De-dup channel ids in case (somehow) two emails share one — keep all
  // emails per channel so we can fan out the same stats to each.
  const channelToEmails = new Map<string, string[]>();
  for (const a of accts.rows) {
    const arr = channelToEmails.get(a.channel_id) || [];
    arr.push(a.account_email);
    channelToEmails.set(a.channel_id, arr);
  }

  const channelIds = [...channelToEmails.keys()];
  for (let i = 0; i < channelIds.length; i += 50) {
    const batch = channelIds.slice(i, i + 50);
    const pair = await getNextYtPair();
    if (!pair) return { ok: false, error: 'no YT API key configured' };

    const url = `https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${batch.join(',')}&key=${pair.key}`;
    const res = await ytFetchViaProxy(url, pair);
    calls++;
    if (!res.ok) {
      errors++;
      if (res.status === 429 || res.status === 403) banYtKey(pair.key);
      continue;
    }
    const data = res.data as { items?: YtChannelItem[] };
    for (const item of data.items || []) {
      const cid = item.id; if (!cid) continue;
      const emails = channelToEmails.get(cid); if (!emails) continue;
      const subs   = parseInt(item.statistics?.subscriberCount || '0') || 0;
      const views  = parseInt(item.statistics?.viewCount       || '0') || 0;
      const videos = parseInt(item.statistics?.videoCount      || '0') || 0;
      const title  = item.snippet?.title     || null;
      const custom = item.snippet?.customUrl || null;
      for (const email of emails) {
        await pool.query(
          `UPDATE vizard_yt_accounts SET
             channel_title    = COALESCE($1, channel_title),
             custom_url       = COALESCE($2, custom_url),
             subscriber_count = $3,
             view_count       = $4,
             video_count      = $5,
             fetched_at       = NOW()
           WHERE account_email = $6`,
          [title, custom, subs, views, videos, email],
        );
        updated++;
      }
    }
  }

  return { ok: true, resolved, updated, errors, calls };
}
