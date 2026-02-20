import { Pool } from 'pg';

// --- Helpers ---

export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '').substring(0, 12);
}

function extractJson(text: string): string {
  let s = text
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) {
    s = s.substring(start, end + 1);
  }
  return s;
}

interface CallGeminiOpts {
  pool: Pool;
  runId: string;
  channelEntryId?: string;
  step: string;
  temperature?: number;
  maxOutputTokens?: number;
}

async function callGemini(
  apiKey: string,
  prompt: string,
  opts: CallGeminiOpts
): Promise<{ parsed: unknown; rawText: string }> {
  const { pool, runId, channelEntryId, step, temperature = 0.3, maxOutputTokens = 4096 } = opts;

  // Insert pending log
  const logResult = await pool.query(
    `INSERT INTO deep_analysis_logs (run_id, channel_entry_id, step, prompt, status)
     VALUES ($1, $2, $3, $4, 'pending') RETURNING id`,
    [runId, channelEntryId || null, step, prompt]
  );
  const logId = logResult.rows[0].id;

  const startTime = Date.now();
  let rawText = '';
  try {
    const response = await fetch(
      'https://papaiapi.com/v1beta/models/gemini-flash:generateContent',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature, maxOutputTokens },
        }),
      }
    );

    const durationMs = Date.now() - startTime;

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Gemini API error ${response.status}: ${errText}`);
    }

    const data = await response.json();
    rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!rawText) throw new Error('No text in Gemini response');

    const tokensIn = data.usageMetadata?.promptTokenCount || null;
    const tokensOut = data.usageMetadata?.candidatesTokenCount || null;

    const jsonStr = extractJson(rawText);
    const parsed = JSON.parse(jsonStr);

    await pool.query(
      `UPDATE deep_analysis_logs SET response = $1, duration_ms = $2, status = 'done',
       tokens_in = $3, tokens_out = $4 WHERE id = $5`,
      [rawText, durationMs, tokensIn, tokensOut, logId]
    );

    return { parsed, rawText };
  } catch (error) {
    const durationMs = Date.now() - startTime;
    const errMsg = error instanceof Error ? error.message : String(error);
    await pool.query(
      `UPDATE deep_analysis_logs SET response = $1, duration_ms = $2, status = 'error', error = $3 WHERE id = $4`,
      [rawText || null, durationMs, errMsg, logId]
    );
    throw error;
  }
}

async function fetchYouTubeVideos(
  channelId: string,
  ytApiKey: string,
  maxResults: number = 10
): Promise<Array<{ video_id: string; title: string; view_count: number; duration_seconds: number | null }>> {
  // Use uploads playlist (replace UC prefix with UU)
  const uploadsPlaylistId = channelId.replace(/^UC/, 'UU');

  const plRes = await fetch(
    `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=${maxResults}&key=${ytApiKey}`
  );
  if (!plRes.ok) return [];
  const plData = await plRes.json();
  const items = plData.items || [];
  if (items.length === 0) return [];

  const videoIds = items.map((it: { snippet: { resourceId: { videoId: string } } }) => it.snippet.resourceId.videoId);

  // Get stats + duration for these videos
  const statsRes = await fetch(
    `https://www.googleapis.com/youtube/v3/videos?part=statistics,contentDetails,snippet&id=${videoIds.join(',')}&key=${ytApiKey}`
  );
  if (!statsRes.ok) return [];
  const statsData = await statsRes.json();

  return (statsData.items || [])
    .map((v: { id: string; snippet: { title: string }; statistics: { viewCount: string }; contentDetails: { duration: string } }) => {
      // Parse ISO 8601 duration (PT1M30S -> 90)
      const dur = v.contentDetails.duration;
      const match = dur.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
      const secs = match
        ? (parseInt(match[1] || '0') * 3600) + (parseInt(match[2] || '0') * 60) + parseInt(match[3] || '0')
        : null;

      return {
        video_id: v.id,
        title: v.snippet.title,
        view_count: Number(v.statistics.viewCount) || 0,
        duration_seconds: secs,
      };
    })
    // Only include Shorts (under 61 seconds)
    .filter((v: { duration_seconds: number | null }) => v.duration_seconds != null && v.duration_seconds <= 61);
}

async function getTopVideos(
  pool: Pool,
  channelId: string,
  count: number,
  ytApiKey?: string
) {
  // Get all unique videos for this channel from DB
  const { rows: allVids } = await pool.query(
    `SELECT DISTINCT ON (video_id) video_id, title, view_count, duration_seconds, collected_at
     FROM shorts_videos WHERE channel_id = $1
     ORDER BY video_id, view_count DESC`,
    [channelId]
  );

  let videos = allVids;

  // If we don't have enough videos, pull more from YouTube Data API
  if (videos.length < count && ytApiKey) {
    try {
      const ytVids = await fetchYouTubeVideos(channelId, ytApiKey, 15);
      const existingIds = new Set(videos.map((v) => v.video_id));
      const newVids = ytVids.filter((v) => !existingIds.has(v.video_id));
      videos = [...videos, ...newVids];
    } catch (err) {
      console.error(`Failed to fetch YouTube videos for ${channelId}:`, err);
    }
  }

  // Top N by views
  const byViews = [...videos].sort((a, b) => Number(b.view_count) - Number(a.view_count));
  const topN = Math.max(1, count - 2);
  const top = byViews.slice(0, topN);
  const topIds = new Set(top.map((v) => v.video_id));

  // 2 most recent that aren't already in top (from DB only, since YT API doesn't have collected_at)
  const dbVids = allVids.filter((v) => !topIds.has(v.video_id));
  const byRecent = [...dbVids].sort(
    (a, b) => new Date(b.collected_at).getTime() - new Date(a.collected_at).getTime()
  );
  const recent = byRecent.slice(0, 2);

  // If no recent from DB, fill from YT results instead
  if (recent.length < 2) {
    const remaining = byViews.filter((v) => !topIds.has(v.video_id) && !recent.some((r) => r.video_id === v.video_id));
    recent.push(...remaining.slice(0, 2 - recent.length));
  }

  return [...top, ...recent].slice(0, count);
}

// --- Prompt Constants ---

export const TRIAGE_PROMPT = (channelData: string, channelCount: number, pickCount: number = 8) =>
  `You are a YouTube Shorts analyst. Below are ${channelCount} channels we discovered recently. Each has basic analysis data.

Your job: Pick the TOP ${pickCount} channels that would be MOST INTERESTING for a deep-dive video-by-video analysis. We want to understand their content strategy, production methods, and what makes them grow.

Prioritize channels that are:
- Unusually fast-growing relative to their age
- Using novel or hard-to-categorize content strategies
- AI-generated content that's actually working (interesting to reverse-engineer)
- Channels where the content style is surprising for their niche
- Channels with high views-per-subscriber ratio (viral potential)
- Channels that might be using templates or formulas worth understanding

De-prioritize:
- Generic/obvious content (standard reaction videos, basic compilations)
- Channels where the strategy is already obvious from the summary
- Low engagement relative to subscribers

Here are the channels:

${channelData}

Respond with a JSON object (no markdown, no code fences) with these fields:

{
  "selected": [
    {
      "channel_name": "...",
      "channel_url": "...",
      "priority": 1,
      "interest_score": 0.95,
      "reason": "2-3 sentences explaining WHY this channel is interesting for deep analysis",
      "what_to_look_for": "What specifically should we examine in their videos?"
    }
  ],
  "skipped_summary": "1-2 sentences explaining why the other channels were not selected"
}

Respond ONLY with the JSON object.`;

export const STORYBOARD_PROMPT = (
  videoUrl: string,
  videoId: string,
  durationSeconds: number | null,
  channelName: string,
  channelSummary: string,
  category: string,
  niche: string,
  contentStyle: string
) =>
  `You are analyzing a YouTube Short video for a content strategy research project.

Watch this video carefully: ${videoUrl}

Channel context: ${channelName} \u2014 ${channelSummary || 'No summary available'}
This channel is in the ${category} > ${niche} space, using ${contentStyle} style.

Create a detailed storyboard of this video. For each distinct segment (2-5 second chunks), capture what is happening.

Respond with a JSON object (no markdown, no code fences) with these fields:

{
  "video_id": "${videoId}",
  "duration_seconds": ${durationSeconds ?? 'null'},
  "storyboard": [
    {
      "timestamp": "00:00 - 00:03",
      "visual_description": "Detailed description of what is shown on screen",
      "action": "What is happening / what changes",
      "text_on_screen": null,
      "audio": "Description of music, sound effects, voiceover type",
      "dialogue": null,
      "strategic_purpose": "Why this segment exists (hook, tension, payoff, CTA, etc.)"
    }
  ],
  "hook_analysis": {
    "type": "question | bold_claim | visual_shock | curiosity_gap | pattern_interrupt | emotional | other",
    "description": "How the first 1-3 seconds grab attention",
    "estimated_hook_duration_seconds": 2
  },
  "ending_analysis": {
    "type": "cliffhanger | CTA | loop | punchline | fade | abrupt | other",
    "description": "How the video ends"
  },
  "production_notes": {
    "editing_style": "fast_cuts | slow_reveal | continuous | montage | other",
    "uses_tts": false,
    "tts_voice_type": "male | female | robotic | none",
    "uses_background_music": true,
    "music_genre": "e.g. dramatic orchestral, lo-fi, phonk, none",
    "uses_ai_visuals": false,
    "visual_source": "ai_generated | screen_recording | real_footage | stock | mixed",
    "caption_style": "animated_word_by_word | static_subtitles | none | other",
    "estimated_production_effort": "low | medium | high"
  },
  "content_template": "A one-sentence formula this video follows"
}

IMPORTANT: Use actual null values, not the string "null". Be precise with timestamps.
Respond ONLY with the JSON object.`;

export const SYNTHESIS_PROMPT = (
  channelName: string,
  channelUrl: string,
  category: string,
  niche: string,
  contentStyle: string,
  subscriberCount: number,
  ageDays: number,
  channelSummary: string,
  storyboardCount: number,
  storyboardsJson: string
) =>
  `You are a YouTube Shorts content strategist doing a deep-dive analysis on a single channel.

Channel: ${channelName}
URL: ${channelUrl}
Category: ${category} > ${niche}
Style: ${contentStyle}
Subscribers: ${subscriberCount.toLocaleString()}
Age: ${ageDays} days
Summary: ${channelSummary}

Below are detailed storyboards from ${storyboardCount} of their videos (3 most viewed + 2 most recent). Each storyboard includes timestamps, visual descriptions, audio, dialogue, production notes, hook/ending analysis, and a content template.

${storyboardsJson}

Based on ALL of these storyboards, produce a comprehensive deep analysis. Look for PATTERNS across videos \u2014 what repeats, what's the formula, what makes this channel work.

Respond with a JSON object (no markdown, no code fences):

{
  "channel_name": "${channelName}",
  "content_strategy": {
    "core_template": "The ONE repeatable formula this channel follows across most videos (be specific)",
    "template_variations": ["How they vary the template to keep it fresh"],
    "posting_rhythm_assessment": "What can we infer about their posting strategy",
    "narrative_structure": "How stories are structured (e.g. setup-conflict-resolution, problem-solution, etc.)"
  },
  "hook_patterns": {
    "dominant_hook_type": "The most common hook type across videos",
    "hook_techniques": ["List specific techniques used in first 1-3 seconds"],
    "estimated_avg_hook_seconds": 2,
    "hook_effectiveness_notes": "Why their hooks work or don't"
  },
  "production_analysis": {
    "visual_style": "Consistent visual approach across videos",
    "audio_strategy": "How they use music, voiceover, sound effects",
    "editing_patterns": "Pacing, cut frequency, transitions",
    "tools_likely_used": ["Best guess at tools/software used"],
    "ai_usage": {
      "uses_ai_visuals": true,
      "uses_ai_voiceover": false,
      "uses_ai_script": false,
      "ai_confidence": "high | medium | low",
      "evidence": "What specific evidence points to AI usage"
    },
    "estimated_time_per_video": "How long it likely takes to produce one video",
    "production_difficulty": "low | medium | high"
  },
  "content_source_analysis": {
    "content_type": "original | repurposed | compiled | ai_generated | hybrid",
    "likely_source": "Where the content/footage comes from",
    "originality_assessment": "How original is this content really?",
    "confidence": "high | medium | low"
  },
  "growth_analysis": {
    "why_it_works": ["Top 3-5 specific reasons this channel is growing"],
    "audience_psychology": "What psychological triggers are they hitting?",
    "viral_mechanics": "What makes individual videos shareable?",
    "retention_tactics": ["Specific things they do to keep viewers watching"]
  },
  "replicability": {
    "score": 0.8,
    "what_you_need": ["List of skills/tools/resources needed to replicate this"],
    "time_to_first_video": "How long would it take a beginner to make their first video in this style",
    "moat": "What's hard to copy about this channel?"
  },
  "executive_summary": "3-4 sentence summary of this channel's strategy, what makes it unique, and its growth outlook"
}

Be specific and evidence-based. Reference specific videos/timestamps when making claims. Avoid generic statements.
Respond ONLY with the JSON object.`;

export const POST_GEN_PROMPT = (synthesisJson: string) =>
  `You are a copywriter for @evgeniirofe on X (Twitter). We analyze YouTube Shorts channels that are blowing up and post breakdowns of HOW they work so aspiring creators can learn from them.

## OUR AUDIENCE
- Aspiring YouTube Shorts creators
- People curious about what's working on Shorts right now
- They want ACTIONABLE insights, not fluff
- They want to know: "What's the formula? Could I do this?"

## POST FORMAT RULES
- Thread of exactly 2 tweets (T1 and T2)
- T1: The MAIN post. Structure it as:
  1. FIRST LINE: The scroll-stopping stats \u2014 raw numbers that make people stop. Format: "[big view count]. [subs]. [age]. Here's the/their [formula name]:" \u2014 this line is MANDATORY
  2. MIDDLE: The formula breakdown with \u25B8 bullets \u2014 what exactly they do
  3. LAST LINE: "The channel name is in the thread \uD83D\uDC47"
  DO NOT mention the channel name in T1.
- T2 is hardcoded (not AI-generated), ignore it.
- T1 can be up to 336 characters (280 + 20% buffer for X thread formatting)
- Use \u25B8 for bullet points
- Use plain language, no corporate speak, no emojis except \uD83D\uDC47 in T1
- Be specific \u2014 numbers, seconds, exact tactics. No vague "great content" statements
- The tone is: data-driven, slightly irreverent, like a smart friend sharing alpha
- T1 should pack maximum value \u2014 someone reading JUST T1 should learn the formula even if they never click through

## WHAT NOT TO DO
- Don't say "in the world of YouTube Shorts" or similar filler
- Don't use words like "revolutionary", "game-changing", "incredible"
- Don't describe the niche as "thriving" or "booming"
- Don't start T1 with "Thread:" or "\uD83E\uDDF5"
- Don't use more than 1 emoji total
- Don't speculate about what tools they use or how long videos take to make
- Don't waste T2 on stats or analysis \u2014 T2 is ONLY the name reveal

## DEEP ANALYSIS DATA
Here is our research on this channel. Use it to write the thread:

${synthesisJson}

Respond with a JSON object (no markdown, no code fences):

{
  "tweet": "The full T1 text here",
  "char_count": 0,
  "hook_category": "speed | niche | doable | ai | discovery"
}

Respond ONLY with the JSON object.`;

// --- Progress Event ---

export interface ProgressEvent {
  step: string;
  channel_name?: string;
  video_id?: string;
  progress?: number;
  total?: number;
  message: string;
}

// --- Filters ---

export interface TriageFilters {
  date: string;       // YYYY-MM-DD, channels first_seen_at this date
  maxAgeDays: number; // channel age filter
  minSubs: number;    // minimum subscriber count
  maxSubs: number;    // 0 = no max
  triageCount: number; // how many to feed to triage (default 30)
  pickCount: number;  // how many triage picks (default 8)
}

export const DEFAULT_FILTERS: TriageFilters = {
  date: new Date().toISOString().split('T')[0],
  maxAgeDays: 90,
  minSubs: 10000,
  maxSubs: 0,
  triageCount: 30,
  pickCount: 8,
};

// --- Main Pipeline ---

export async function runDeepAnalysis(
  pool: Pool,
  apiKey: string,
  onProgress: (event: ProgressEvent) => void,
  filters: TriageFilters = DEFAULT_FILTERS
): Promise<string> {
  const runId = generateId();

  // Get YouTube API key for supplementing videos
  let ytApiKey: string | undefined;
  try {
    const { rows } = await pool.query(`SELECT value FROM admin_config WHERE key = 'youtube_api_key'`);
    ytApiKey = rows[0]?.value || process.env.YOUTUBE_API_KEY;
  } catch {}

  // Create run record
  await pool.query(
    `INSERT INTO deep_analysis_runs (id, status) VALUES ($1, 'pending')`,
    [runId]
  );

  try {
    // ===== STEP 1: TRIAGE =====
    await pool.query(`UPDATE deep_analysis_runs SET status = 'triage' WHERE id = $1`, [runId]);
    onProgress({ step: 'triage', message: 'Fetching channels for triage...', progress: 0, total: 1 });

    // Build dynamic WHERE from filters
    const conditions: string[] = [
      `ca.status = 'done'`,
      `sc.first_seen_at::date = $1::date`,
    ];
    const queryParams: (string | number)[] = [filters.date];
    let paramIdx = 2;

    if (filters.maxAgeDays > 0) {
      conditions.push(`sc.channel_creation_date > NOW() - INTERVAL '${Math.round(filters.maxAgeDays)} days'`);
    }
    if (filters.minSubs > 0) {
      conditions.push(`sc.subscriber_count >= $${paramIdx}`);
      queryParams.push(filters.minSubs);
      paramIdx++;
    }
    if (filters.maxSubs > 0) {
      conditions.push(`sc.subscriber_count <= $${paramIdx}`);
      queryParams.push(filters.maxSubs);
      paramIdx++;
    }

    const { rows: channels } = await pool.query(`
      SELECT
        sc.channel_id, sc.channel_name, sc.channel_url,
        sc.subscriber_count, sc.total_video_count,
        EXTRACT(DAY FROM NOW() - sc.channel_creation_date)::int as age_days,
        ca.category, ca.niche, ca.sub_niche, ca.content_style,
        ca.is_ai_generated, ca.channel_summary, ca.tags,
        (SELECT COALESCE(SUM(sv.view_count), 0) FROM shorts_videos sv WHERE sv.channel_id = sc.channel_id) as total_views,
        (SELECT MAX(sv.view_count) FROM shorts_videos sv WHERE sv.channel_id = sc.channel_id) as top_video_views
      FROM shorts_channels sc
      INNER JOIN channel_analysis ca ON ca.channel_id = sc.channel_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY sc.subscriber_count DESC
      LIMIT $${paramIdx}
    `, [...queryParams, filters.triageCount]);

    if (channels.length === 0) {
      throw new Error('No channels matching filters found for triage');
    }

    const channelSummaries = channels.map((ch, i) => ({
      index: i + 1,
      channel_name: ch.channel_name,
      channel_url: ch.channel_url,
      subscribers: Number(ch.subscriber_count),
      age_days: ch.age_days,
      total_videos: Number(ch.total_video_count),
      total_views: Number(ch.total_views),
      top_video_views: Number(ch.top_video_views),
      category: ch.category,
      niche: ch.niche,
      sub_niche: ch.sub_niche,
      content_style: ch.content_style,
      is_ai_generated: ch.is_ai_generated,
      summary: ch.channel_summary,
      tags: ch.tags,
    }));

    onProgress({ step: 'triage', message: `Triaging ${channels.length} channels...`, progress: 0, total: 1 });

    const triagePrompt = TRIAGE_PROMPT(JSON.stringify(channelSummaries, null, 2), channels.length, filters.pickCount);
    const { parsed: triageResult } = await callGemini(apiKey, triagePrompt, {
      pool, runId, step: 'triage', temperature: 0.4,
    });

    const selected = (triageResult as { selected: Array<{
      channel_name: string; channel_url: string; priority: number;
      interest_score: number; reason: string; what_to_look_for: string;
    }> }).selected || [];

    // Insert channel entries
    const channelEntries: Array<{ entryId: string; channelId: string; channelName: string; channelUrl: string; sel: typeof selected[0] }> = [];
    for (const sel of selected) {
      // Find matching channel from our DB data
      const dbCh = channels.find(
        (c) => c.channel_name === sel.channel_name || c.channel_url === sel.channel_url
      );
      if (!dbCh) continue;

      const entryId = generateId();
      await pool.query(
        `INSERT INTO deep_analysis_channels (id, run_id, channel_id, channel_name, channel_url, priority, interest_score, triage_reason, what_to_look_for, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')`,
        [entryId, runId, dbCh.channel_id, dbCh.channel_name, dbCh.channel_url,
         sel.priority, sel.interest_score, sel.reason, sel.what_to_look_for]
      );
      channelEntries.push({ entryId, channelId: dbCh.channel_id, channelName: dbCh.channel_name, channelUrl: dbCh.channel_url, sel });
    }

    await pool.query(
      `UPDATE deep_analysis_runs SET channel_count = $1 WHERE id = $2`,
      [channelEntries.length, runId]
    );

    onProgress({ step: 'triage', message: `Triage complete: ${channelEntries.length} channels selected`, progress: 1, total: 1 });

    // ===== STEPS 2-4: Process each channel fully (storyboard → synthesis → post) one at a time =====
    // Get channel metadata for prompts
    const channelMeta: Record<string, { category: string; niche: string; contentStyle: string; summary: string }> = {};
    for (const ch of channels) {
      channelMeta[ch.channel_id] = {
        category: ch.category || 'Unknown',
        niche: ch.niche || 'Unknown',
        contentStyle: ch.content_style || 'unknown',
        summary: ch.channel_summary || '',
      };
    }

    for (let chIdx = 0; chIdx < channelEntries.length; chIdx++) {
      const entry = channelEntries[chIdx];
      const meta = channelMeta[entry.channelId] || { category: 'Unknown', niche: 'Unknown', contentStyle: 'unknown', summary: '' };
      const dbCh = channels.find((c) => c.channel_id === entry.channelId);

      // --- STORYBOARD this channel ---
      await pool.query(`UPDATE deep_analysis_runs SET status = 'storyboarding' WHERE id = $1`, [runId]);
      await pool.query(`UPDATE deep_analysis_channels SET status = 'storyboarding' WHERE id = $1`, [entry.entryId]);

      const videos = await getTopVideos(pool, entry.channelId, 5, ytApiKey);

      onProgress({
        step: 'storyboarding',
        channel_name: entry.channelName,
        progress: chIdx,
        total: channelEntries.length,
        message: `Storyboarding ${entry.channelName} (${chIdx + 1}/${channelEntries.length}) — ${videos.length} videos...`,
      });

      // Process videos with max 3 concurrent calls
      const concurrency = 3;
      let completedVids = 0;
      for (let i = 0; i < videos.length; i += concurrency) {
        const batch = videos.slice(i, i + concurrency);
        await Promise.all(
          batch.map(async (video) => {
            const sbId = generateId();
            const videoUrl = `https://www.youtube.com/shorts/${video.video_id}`;

            try {
              const prompt = STORYBOARD_PROMPT(
                videoUrl, video.video_id, video.duration_seconds,
                entry.channelName, meta.summary, meta.category, meta.niche, meta.contentStyle
              );

              const { parsed } = await callGemini(apiKey, prompt, {
                pool, runId, channelEntryId: entry.entryId, step: 'storyboard',
              });

              await pool.query(
                `INSERT INTO deep_analysis_storyboards (id, channel_entry_id, video_id, video_title, view_count, storyboard, status)
                 VALUES ($1, $2, $3, $4, $5, $6, 'done')`,
                [sbId, entry.entryId, video.video_id, video.title, video.view_count, JSON.stringify(parsed)]
              );
            } catch (error) {
              const errMsg = error instanceof Error ? error.message : String(error);
              await pool.query(
                `INSERT INTO deep_analysis_storyboards (id, channel_entry_id, video_id, video_title, view_count, status, error)
                 VALUES ($1, $2, $3, $4, $5, 'error', $6)`,
                [sbId, entry.entryId, video.video_id, video.title, video.view_count, errMsg]
              );
            }

            completedVids++;
            onProgress({
              step: 'storyboarding',
              channel_name: entry.channelName,
              video_id: video.video_id,
              progress: chIdx,
              total: channelEntries.length,
              message: `Storyboarding ${entry.channelName} — video ${completedVids}/${videos.length}`,
            });
          })
        );
      }

      // --- SYNTHESIS for this channel ---
      await pool.query(`UPDATE deep_analysis_runs SET status = 'synthesizing' WHERE id = $1`, [runId]);
      await pool.query(`UPDATE deep_analysis_channels SET status = 'synthesizing' WHERE id = $1`, [entry.entryId]);

      onProgress({
        step: 'synthesis',
        channel_name: entry.channelName,
        progress: chIdx,
        total: channelEntries.length,
        message: `Synthesizing ${entry.channelName} (${chIdx + 1}/${channelEntries.length})...`,
      });

      try {
        const { rows: storyboards } = await pool.query(
          `SELECT storyboard FROM deep_analysis_storyboards WHERE channel_entry_id = $1 AND status = 'done'`,
          [entry.entryId]
        );

        if (storyboards.length === 0) {
          await pool.query(
            `UPDATE deep_analysis_channels SET status = 'error', error = 'No storyboards available' WHERE id = $1`,
            [entry.entryId]
          );
          continue;
        }

        const storyboardData = storyboards.map((s) => s.storyboard);
        const subscriberCount = Number(dbCh?.subscriber_count || 0);
        const ageDays = Number(dbCh?.age_days || 0);

        const synthPrompt = SYNTHESIS_PROMPT(
          entry.channelName, entry.channelUrl,
          meta.category, meta.niche, meta.contentStyle,
          subscriberCount, ageDays, meta.summary,
          storyboardData.length, JSON.stringify(storyboardData, null, 2)
        );

        const { parsed: synthParsed } = await callGemini(apiKey, synthPrompt, {
          pool, runId, channelEntryId: entry.entryId, step: 'synthesis',
          temperature: 0.4, maxOutputTokens: 8192,
        });

        await pool.query(
          `UPDATE deep_analysis_channels SET synthesis = $1 WHERE id = $2`,
          [JSON.stringify(synthParsed), entry.entryId]
        );

        // --- POST GEN for this channel ---
        await pool.query(`UPDATE deep_analysis_runs SET status = 'post_gen' WHERE id = $1`, [runId]);

        onProgress({
          step: 'post_gen',
          channel_name: entry.channelName,
          progress: chIdx,
          total: channelEntries.length,
          message: `Generating post for ${entry.channelName} (${chIdx + 1}/${channelEntries.length})...`,
        });

        const enrichedSynthesis = {
          ...(synthParsed as Record<string, unknown>),
          channel_url: entry.channelUrl,
          subscribers: subscriberCount,
          age_days: ageDays,
          total_videos: Number(dbCh?.total_video_count || 0),
          top_video_views: Number(dbCh?.top_video_views || 0),
        };

        const postPrompt = POST_GEN_PROMPT(JSON.stringify(enrichedSynthesis, null, 2));
        const { parsed: postParsed } = await callGemini(apiKey, postPrompt, {
          pool, runId, channelEntryId: entry.entryId, step: 'post_gen',
          temperature: 0.7, maxOutputTokens: 2048,
        });

        const postResult = postParsed as { tweet: string; hook_category: string };
        await pool.query(
          `UPDATE deep_analysis_channels SET post_tweet = $1, post_hook_category = $2, status = 'done' WHERE id = $3`,
          [postResult.tweet, postResult.hook_category, entry.entryId]
        );

        onProgress({
          step: 'post_gen',
          channel_name: entry.channelName,
          progress: chIdx + 1,
          total: channelEntries.length,
          message: `${entry.channelName} complete (${chIdx + 1}/${channelEntries.length})`,
        });
      } catch (error) {
        const errMsg = error instanceof Error ? error.message : String(error);
        await pool.query(
          `UPDATE deep_analysis_channels SET status = 'error', error = $1 WHERE id = $2`,
          [errMsg, entry.entryId]
        );
      }
    }

    // Mark run as done
    await pool.query(
      `UPDATE deep_analysis_runs SET status = 'done', completed_at = NOW() WHERE id = $1`,
      [runId]
    );

    onProgress({ step: 'done', message: 'Deep analysis complete', progress: 1, total: 1 });

    return runId;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    await pool.query(
      `UPDATE deep_analysis_runs SET status = 'error', error = $1, completed_at = NOW() WHERE id = $2`,
      [errMsg, runId]
    );
    throw error;
  }
}
