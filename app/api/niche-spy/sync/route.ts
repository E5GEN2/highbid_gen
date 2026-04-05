import { NextResponse } from 'next/server';
import { getPool } from '@/lib/db';

const XGODO_API = 'https://xgodo.com/api/v2';
const NICHE_SPY_JOB_ID = '69a58c4277cb8e2b9f1dddc4';

async function getXgodoToken(): Promise<string> {
  const pool = await getPool();
  const res = await pool.query("SELECT value FROM admin_config WHERE key = 'xgodo_niche_spy_token'");
  if (res.rows[0]?.value) return res.rows[0].value;
  // Fallback to env vars
  return process.env.XGODO_NICHE_SPY_TOKEN || process.env.XGODO_API_TOKEN || '';
}

// --- Helpers ---

/** Parse "1,374,202 views" or "141K subscribers" or "1.2K" or "12 thousand likes" → number */
function parseCount(s: string | null | undefined): number {
  if (!s) return 0;
  const str = String(s).replace(/,/g, '').replace(/\s*(views|subscribers|likes|comments)\s*/gi, '').trim();
  if (!str) return 0;
  const upper = str.toUpperCase();
  if (upper.includes('THOUSAND')) return Math.round(parseFloat(str) * 1000);
  if (upper.endsWith('K')) return Math.round(parseFloat(str) * 1000);
  if (upper.endsWith('M')) return Math.round(parseFloat(str) * 1_000_000);
  if (upper.endsWith('B')) return Math.round(parseFloat(str) * 1_000_000_000);
  return parseInt(str) || 0;
}

/** Parse "2 years ago" relative to anchor date → absolute Date */
function parseRelativeDate(text: string | null, anchor: Date): Date | null {
  if (!text) return null;
  const match = text.match(/(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago/i);
  if (!match) return null;
  const n = parseInt(match[1]);
  const unit = match[2].toLowerCase();
  const d = new Date(anchor);
  switch (unit) {
    case 'second': d.setSeconds(d.getSeconds() - n); break;
    case 'minute': d.setMinutes(d.getMinutes() - n); break;
    case 'hour': d.setHours(d.getHours() - n); break;
    case 'day': d.setDate(d.getDate() - n); break;
    case 'week': d.setDate(d.getDate() - n * 7); break;
    case 'month': d.setMonth(d.getMonth() - n); break;
    case 'year': d.setFullYear(d.getFullYear() - n); break;
  }
  return d;
}

/** Normalize YouTube URL to canonical youtu.be/VIDEO_ID */
function normalizeUrl(url: string): string | null {
  const match = url.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/)([a-zA-Z0-9_-]{11})/);
  return match ? `https://youtu.be/${match[1]}` : url || null;
}

/** Extract first non-empty value from a source object by multiple key names */
function getField(source: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = source[k];
    if (v !== null && v !== undefined && String(v).trim()) return String(v).trim();
  }
  return '';
}

/** Parse JSON safely — handles both string and object */
function safeParse(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try { return JSON.parse(String(raw)); } catch { return {}; }
}

interface ParsedVideo {
  taskId: string;
  keyword: string;
  url: string;
  title: string;
  viewCount: string;
  channelName: string;
  postedDate: string;
  score: string;
  subscriberCount: string;
  likeCount: string;
  commentCount: string;
  topComment: string;
  thumbnail: string;
}

/** Parse videos from a single xgodo task */
function parseTask(task: Record<string, unknown>): { videos: ParsedVideo[]; keyword: string; saturation: Record<string, unknown> | null } {
  const taskId = String(task.job_task_id || task._id || '');
  const plannedTask = safeParse(task.planned_task);
  const jobProof = safeParse(task.job_proof);

  // Extract keyword (priority chain)
  const keyword = String(
    plannedTask.keyword || jobProof.keyword || jobProof.searchQuery || jobProof.query || jobProof.search_query || ''
  );

  const seenUrls = new Set<string>();
  const videos: ParsedVideo[] = [];

  // Process geminiScores first (richer data), then allDiscoveredVideos
  const sources = [
    ...(Array.isArray(jobProof.geminiScores) ? jobProof.geminiScores : []),
    ...(Array.isArray(jobProof.allDiscoveredVideos) ? jobProof.allDiscoveredVideos : []),
  ];

  for (const raw of sources) {
    const src = typeof raw === 'object' && raw ? raw as Record<string, unknown> : {};
    const rawUrl = getField(src, 'url', 'videoUrl', 'video_url', 'link');
    const url = normalizeUrl(rawUrl);
    if (!url || seenUrls.has(url)) continue;

    const score = getField(src, 'score', 'engagement_score');
    if (score === '0' || score === '') continue; // Skip zero-score

    seenUrls.add(url);
    videos.push({
      taskId,
      keyword,
      url,
      title: getField(src, 'title', 'videoTitle'),
      viewCount: getField(src, 'viewCount', 'view_count', 'views'),
      channelName: getField(src, 'channelName', 'channel_name', 'channel'),
      postedDate: getField(src, 'postedDate', 'posted_date', 'publishedAt', 'date'),
      score,
      subscriberCount: getField(src, 'subscriberCount', 'subscriber_count', 'subscribers'),
      likeCount: getField(src, 'likeCount', 'like_count', 'likes'),
      commentCount: getField(src, 'commentCount', 'comment_count', 'comments'),
      topComment: getField(src, 'topComment', 'top_comment', 'comment'),
      thumbnail: getField(src, 'thumbnail', 'thumbnailUrl', 'thumbnail_url'),
    });
  }

  // Saturation summary
  const sat = jobProof.saturationSummary as Record<string, unknown> | undefined;
  const saturation = sat ? { keyword, taskId, ...sat } : null;

  return { videos, keyword, saturation };
}

/**
 * POST /api/niche-spy/sync
 * Pull tasks from xgodo API, parse videos, upsert to local DB, confirm tasks.
 * Returns progress report.
 */
export async function POST() {
  const pool = await getPool();
  const now = new Date();

  const xgodoToken = await getXgodoToken();
  if (!xgodoToken) {
    return NextResponse.json({ error: 'xgodo_niche_spy_token not configured. Set it in Admin settings.' }, { status: 500 });
  }

  try {
    // Step 1: Fetch tasks from xgodo
    const fetchRes = await fetch(`${XGODO_API}/jobs/applicants`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${xgodoToken}`,
      },
      body: JSON.stringify({
        job_id: NICHE_SPY_JOB_ID,
        limit: 100,
        status: 'processing',
      }),
    });

    if (!fetchRes.ok) {
      const errText = await fetchRes.text();
      return NextResponse.json({ error: `xgodo API error ${fetchRes.status}: ${errText.substring(0, 200)}` }, { status: 500 });
    }

    const fetchData = await fetchRes.json();
    const tasks = fetchData.job_tasks || [];

    if (tasks.length === 0) {
      const { rows: [{ cnt }] } = await pool.query('SELECT COUNT(*) as cnt FROM niche_spy_videos');
      return NextResponse.json({
        status: 'idle',
        message: 'No pending tasks',
        tasksProcessed: 0,
        videosInserted: 0,
        videosUpdated: 0,
        totalLocal: parseInt(cnt),
      });
    }

    // Step 2: Parse all tasks — collect videos grouped by keyword
    const taskIds: string[] = [];
    const allSaturations: Array<Record<string, unknown>> = [];
    const videosByKeyword: Record<string, ParsedVideo[]> = {};

    for (const task of tasks) {
      const { videos, keyword, saturation } = parseTask(task);
      const tid = String(task.job_task_id || task._id || '');
      if (tid) taskIds.push(tid);
      if (saturation) allSaturations.push(saturation);

      if (!videosByKeyword[keyword]) videosByKeyword[keyword] = [];
      videosByKeyword[keyword].push(...videos);
    }

    // Step 2b: Calculate A/B/C saturation BEFORE inserting (per keyword)
    const saturationResults: Array<{ keyword: string; knownBefore: number; runTotal: number; A: number; B: number; C: number; runSatPct: number; globalSatPct: number }> = [];

    for (const [keyword, videos] of Object.entries(videosByKeyword)) {
      if (!keyword || videos.length === 0) continue;

      const runUrls = [...new Set(videos.map(v => v.url).filter(Boolean))];
      if (runUrls.length === 0) continue;

      // known_before: how many videos for this keyword already in DB
      const { rows: [{ cnt: knownBeforeStr }] } = await pool.query(
        `SELECT COUNT(*) as cnt FROM niche_spy_videos WHERE keyword = $1`,
        [keyword]
      );
      const knownBefore = parseInt(knownBeforeStr) || 0;

      // Find which of this run's URLs already exist in DB
      const { rows: existingRows } = await pool.query(
        `SELECT url FROM niche_spy_videos WHERE url = ANY($1)`,
        [runUrls]
      );
      const existingUrls = new Set(existingRows.map(r => r.url));

      const A = runUrls.filter(u => !existingUrls.has(u)).length; // new
      const B = runUrls.filter(u => existingUrls.has(u)).length;  // overlap
      const C = knownBefore - B; // missed (in DB but not in this run)
      const runSatPct = (A + B) > 0 ? Math.round((B / (A + B)) * 10000) / 100 : 0;
      const universeSize = knownBefore + A;
      const globalSatPct = universeSize > 0 ? Math.round((knownBefore / universeSize) * 10000) / 100 : 0;

      saturationResults.push({ keyword, knownBefore, runTotal: runUrls.length, A, B, C, runSatPct, globalSatPct });

      // Save saturation run record
      await pool.query(
        `INSERT INTO niche_saturation_runs (keyword, known_before, run_total, new_count, overlap_count, missed_count, run_saturation_pct, global_saturation_pct, niche_universe_size)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [keyword, knownBefore, runUrls.length, A, B, C, runSatPct, globalSatPct, universeSize]
      ).catch(() => {});
    }

    // Step 3: NOW insert/update the videos
    let totalVideos = 0;
    let newInserts = 0;
    let updates = 0;
    let skipped = 0;
    const keywordStats: Record<string, { total: number; new: number }> = {};

    for (const [keyword, videos] of Object.entries(videosByKeyword)) {
      if (!keywordStats[keyword]) keywordStats[keyword] = { total: 0, new: 0 };

      for (const v of videos) {
        totalVideos++;
        keywordStats[keyword].total++;
        // Only store posted_at if it's an absolute date (ISO/parseable), not relative ("2 months ago")
        let postedAt: Date | null = null;
        if (v.postedDate && !v.postedDate.match(/\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago/i)) {
          const parsed = new Date(v.postedDate);
          if (!isNaN(parsed.getTime())) postedAt = parsed;
        }

        try {
          const result = await pool.query(
            `INSERT INTO niche_spy_videos
             (task_id, keyword, url, title, view_count, channel_name, posted_date, posted_at, score, subscriber_count, like_count, comment_count, top_comment, thumbnail, fetched_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
             ON CONFLICT (url) DO UPDATE SET
               keyword = CASE WHEN niche_spy_videos.keyword = '' OR niche_spy_videos.keyword IS NULL THEN EXCLUDED.keyword ELSE niche_spy_videos.keyword END,
               title = CASE WHEN niche_spy_videos.title = '' OR niche_spy_videos.title IS NULL THEN EXCLUDED.title ELSE niche_spy_videos.title END,
               view_count = GREATEST(niche_spy_videos.view_count, EXCLUDED.view_count),
               score = GREATEST(niche_spy_videos.score, EXCLUDED.score),
               subscriber_count = GREATEST(niche_spy_videos.subscriber_count, EXCLUDED.subscriber_count),
               like_count = GREATEST(niche_spy_videos.like_count, EXCLUDED.like_count),
               comment_count = GREATEST(niche_spy_videos.comment_count, EXCLUDED.comment_count),
               top_comment = CASE WHEN niche_spy_videos.top_comment = '' OR niche_spy_videos.top_comment IS NULL THEN EXCLUDED.top_comment ELSE niche_spy_videos.top_comment END,
               thumbnail = CASE WHEN niche_spy_videos.thumbnail = '' OR niche_spy_videos.thumbnail IS NULL THEN EXCLUDED.thumbnail ELSE niche_spy_videos.thumbnail END
             RETURNING (xmax = 0) as is_insert`,
            [
              v.taskId, v.keyword, v.url, v.title,
              parseCount(v.viewCount), v.channelName, v.postedDate, postedAt,
              parseInt(v.score) || 0,
              parseCount(v.subscriberCount), parseCount(v.likeCount), parseCount(v.commentCount),
              v.topComment, v.thumbnail, now,
            ]
          );

          if (result.rows[0]?.is_insert) {
            newInserts++;
            keywordStats[keyword].new++;
          } else {
            updates++;
          }
        } catch (err) {
          skipped++;
          console.error('[niche-spy] Insert error:', (err as Error).message?.substring(0, 100));
        }
      }
    }

    // Step 3: Save saturation records
    for (const sat of allSaturations) {
      await pool.query(
        `INSERT INTO niche_spy_saturation (keyword, task_id, total_seen, total_known, total_unseen, saturation_pct)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [sat.keyword, sat.taskId, sat.totalSeen || 0, sat.totalKnown || 0, sat.totalUnseen || 0, sat.saturationPct || 0]
      ).catch(() => {}); // Ignore if table doesn't exist yet
    }

    // Step 4: Confirm tasks back to xgodo
    let confirmed = 0;
    if (taskIds.length > 0) {
      for (let i = 0; i < taskIds.length; i += 100) {
        const batch = taskIds.slice(i, i + 100);
        try {
          await fetch(`${XGODO_API}/jobs/applicants`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${xgodoToken}`,
            },
            body: JSON.stringify({
              JobTasks_Ids: batch,
              status: 'confirmed',
              job_id: NICHE_SPY_JOB_ID,
              comment: 'Auto-confirmed: rofe.ai niche spy sync',
            }),
          });
          confirmed += batch.length;
        } catch (err) {
          console.error('[niche-spy] Confirm error:', (err as Error).message);
        }
      }
    }

    // Step 5: Get totals
    const { rows: [{ cnt: totalLocal }] } = await pool.query('SELECT COUNT(*) as cnt FROM niche_spy_videos');
    const { rows: [{ cnt: totalKeywords }] } = await pool.query('SELECT COUNT(DISTINCT keyword) as cnt FROM niche_spy_videos WHERE keyword IS NOT NULL');

    // Save pipeline run
    await pool.query(
      `INSERT INTO niche_spy_pipeline_runs (ran_at, fetched, quality, duplicates, confirmed, new_urls, scheduled, declined)
       VALUES ($1, $2, $3, $4, $5, $6, 0, 0)`,
      [now, totalVideos, newInserts, updates, confirmed, newInserts, ]
    ).catch(() => {});

    return NextResponse.json({
      status: 'done',
      tasksProcessed: tasks.length,
      tasksConfirmed: confirmed,
      videosFound: totalVideos,
      videosInserted: newInserts,
      videosUpdated: updates,
      videosSkipped: skipped,
      saturationRecords: allSaturations.length,
      totalLocal: parseInt(totalLocal),
      totalKeywords: parseInt(totalKeywords),
      keywordBreakdown: Object.entries(keywordStats)
        .sort(([, a], [, b]) => b.total - a.total)
        .slice(0, 20)
        .map(([kw, s]) => ({ keyword: kw, total: s.total, new: s.new })),
      saturation: saturationResults,
    });
  } catch (err) {
    console.error('[niche-spy sync]', err);
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Sync failed' }, { status: 500 });
  }
}

export const maxDuration = 120;
