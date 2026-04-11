import pg from 'pg';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const envPath = resolve(__dirname, '..', '.env.local');
const envContent = readFileSync(envPath, 'utf-8');
const env = {};
for (const line of envContent.split('\n')) {
  const [key, ...rest] = line.split('=');
  if (key && rest.length) env[key.trim()] = rest.join('=').trim();
}

const DATABASE_URL = env.DATABASE_URL;
const PAPAI_API_KEY = env.PAPAI_API_KEY;

const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Step 1: Find a channel with the most unique videos in DB
console.log('--- Finding channel with most videos in DB ---\n');

const { rows: candidates } = await pool.query(`
  SELECT sc.channel_id, sc.channel_name, sc.channel_url, sc.subscriber_count,
         EXTRACT(DAY FROM NOW() - sc.channel_creation_date)::int as age_days,
         ca.channel_summary, ca.niche, ca.content_style, ca.category,
         COUNT(DISTINCT sv.video_id) as unique_vids
  FROM shorts_channels sc
  INNER JOIN channel_analysis ca ON ca.channel_id = sc.channel_id AND ca.status = 'done'
  INNER JOIN shorts_videos sv ON sv.channel_id = sc.channel_id
  WHERE sc.subscriber_count > 10000
  GROUP BY sc.channel_id, sc.channel_name, sc.channel_url, sc.subscriber_count,
           sc.channel_creation_date, ca.channel_summary, ca.niche, ca.content_style, ca.category
  HAVING COUNT(DISTINCT sv.video_id) >= 5
  ORDER BY COUNT(DISTINCT sv.video_id) DESC
  LIMIT 10
`);

console.log('Channels with 5+ videos:');
for (const c of candidates) {
  console.log(`  ${c.channel_name} | ${c.unique_vids} videos | ${Number(c.subscriber_count).toLocaleString()} subs | ${c.category} > ${c.niche}`);
}

if (candidates.length === 0) {
  console.log('No channels with 5+ videos found!');
  await pool.end();
  process.exit(1);
}

// Pick the first one
const channel = candidates[0];
console.log(`\n${'='.repeat(80)}`);
console.log(`DEEP STORYBOARDING: ${channel.channel_name} (${channel.unique_vids} videos in DB)`);
console.log(`${channel.category} > ${channel.niche} | ${channel.content_style}`);
console.log(`${Number(channel.subscriber_count).toLocaleString()} subs | ${channel.age_days}d old`);
console.log(`${'='.repeat(80)}\n`);

// Get videos: top 3 by views + 2 most recent (deduplicated)
const { rows: allVids } = await pool.query(`
  SELECT DISTINCT ON (video_id) video_id, title, view_count, duration_seconds, collected_at
  FROM shorts_videos
  WHERE channel_id = $1
  ORDER BY video_id, view_count DESC
`, [channel.channel_id]);

const byViews = [...allVids].sort((a, b) => Number(b.view_count) - Number(a.view_count));
const top3 = byViews.slice(0, 3);
const top3Ids = new Set(top3.map(v => v.video_id));
const byRecent = [...allVids].sort((a, b) => new Date(b.collected_at).getTime() - new Date(a.collected_at).getTime());
const recent2 = byRecent.filter(v => !top3Ids.has(v.video_id)).slice(0, 2);
const selectedVideos = [...top3, ...recent2];

console.log(`Selected ${selectedVideos.length} videos (3 top + ${recent2.length} recent):`);
for (const v of selectedVideos) {
  console.log(`  ${v.video_id} | ${Number(v.view_count).toLocaleString()} views | ${v.duration_seconds}s | ${v.title?.substring(0, 60)}`);
}

// Step 2: Run storyboard on all 5 in parallel
console.log(`\n--- Running ${selectedVideos.length} storyboard calls in parallel ---\n`);

const storyboardResults = [];
const startAll = Date.now();

const promises = selectedVideos.map(async (video, idx) => {
  const videoUrl = `https://www.youtube.com/shorts/${video.video_id}`;

  const prompt = `You are analyzing a YouTube Short video for a content strategy research project.

Watch this video carefully: ${videoUrl}

Channel context: ${channel.channel_name} — ${channel.channel_summary || 'No summary available'}
This channel is in the ${channel.category} > ${channel.niche} space, using ${channel.content_style} style.

Create a detailed storyboard of this video. For each distinct segment (2-5 second chunks), capture what is happening.

Respond with a JSON object (no markdown, no code fences) with these fields:

{
  "video_id": "${video.video_id}",
  "duration_seconds": ${video.duration_seconds || 'null'},
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

  const startTime = Date.now();

  const response = await fetch(
    'https://papaiapi.com/v1beta/models/gemini-flash:generateContent',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': PAPAI_API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 4096 },
      }),
    }
  );

  const elapsed = Date.now() - startTime;

  if (!response.ok) {
    const errText = await response.text();
    console.error(`  [${idx + 1}] FAILED ${video.video_id}: ${response.status} — ${errText.substring(0, 200)}`);
    return null;
  }

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    console.error(`  [${idx + 1}] No text for ${video.video_id}`);
    return null;
  }

  let jsonStr = rawText.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const s = jsonStr.indexOf('{');
  const e = jsonStr.lastIndexOf('}');
  if (s !== -1 && e > s) jsonStr = jsonStr.substring(s, e + 1);

  try {
    const result = JSON.parse(jsonStr);
    console.log(`  [${idx + 1}] ${video.video_id} — ${(elapsed / 1000).toFixed(1)}s — ${result.storyboard?.length || 0} segments — hook: ${result.hook_analysis?.type} — template: ${result.content_template?.substring(0, 80)}`);
    return result;
  } catch {
    console.error(`  [${idx + 1}] JSON parse failed for ${video.video_id}: ${rawText.substring(0, 200)}`);
    return null;
  }
});

const results = await Promise.all(promises);
const storyboards = results.filter(Boolean);

const totalElapsed = Date.now() - startAll;
console.log(`\nAll ${storyboards.length}/${selectedVideos.length} storyboards completed in ${(totalElapsed / 1000).toFixed(1)}s\n`);

// Print each storyboard summary
for (const sb of storyboards) {
  console.log(`--- ${sb.video_id} (${sb.duration_seconds}s) ---`);
  console.log(`  Hook: ${sb.hook_analysis?.type} — ${sb.hook_analysis?.description}`);
  console.log(`  Ending: ${sb.ending_analysis?.type} — ${sb.ending_analysis?.description}`);
  console.log(`  Production: ${sb.production_notes?.editing_style} | TTS: ${sb.production_notes?.uses_tts} | AI visuals: ${sb.production_notes?.uses_ai_visuals} | Source: ${sb.production_notes?.visual_source}`);
  console.log(`  Template: ${sb.content_template}`);
  console.log('');
}

// Step 3: Synthesis call
console.log(`${'='.repeat(80)}`);
console.log('SYNTHESIS: Combining all storyboards into deep analysis');
console.log(`${'='.repeat(80)}\n`);

const synthesisPrompt = `You are a YouTube Shorts content strategist doing a deep-dive analysis on a single channel.

Channel: ${channel.channel_name}
URL: ${channel.channel_url}
Category: ${channel.category} > ${channel.niche}
Style: ${channel.content_style}
Subscribers: ${Number(channel.subscriber_count).toLocaleString()}
Age: ${channel.age_days} days
Summary: ${channel.channel_summary}

Below are detailed storyboards from ${storyboards.length} of their videos (3 most viewed + 2 most recent). Each storyboard includes timestamps, visual descriptions, audio, dialogue, production notes, hook/ending analysis, and a content template.

${JSON.stringify(storyboards, null, 2)}

Based on ALL of these storyboards, produce a comprehensive deep analysis. Look for PATTERNS across videos — what repeats, what's the formula, what makes this channel work.

Respond with a JSON object (no markdown, no code fences):

{
  "channel_name": "${channel.channel_name}",
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

console.log(`Synthesis prompt: ${synthesisPrompt.length} chars\n`);

const synthStart = Date.now();

const synthResponse = await fetch(
  'https://papaiapi.com/v1beta/models/gemini-flash:generateContent',
  {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': PAPAI_API_KEY,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: synthesisPrompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
    }),
  }
);

const synthElapsed = Date.now() - synthStart;
console.log(`Synthesis responded in ${(synthElapsed / 1000).toFixed(1)}s (status: ${synthResponse.status})\n`);

if (!synthResponse.ok) {
  console.error('Synthesis API error:', await synthResponse.text());
  await pool.end();
  process.exit(1);
}

const synthData = await synthResponse.json();
const synthText = synthData.candidates?.[0]?.content?.parts?.[0]?.text;

let synthJson = synthText.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
const ss = synthJson.indexOf('{');
const se = synthJson.lastIndexOf('}');
if (ss !== -1 && se > ss) synthJson = synthJson.substring(ss, se + 1);

let synthesis;
try {
  synthesis = JSON.parse(synthJson);
} catch (e) {
  console.error('Failed to parse synthesis JSON:');
  console.error(synthText?.substring(0, 500));
  await pool.end();
  process.exit(1);
}

// Pretty print synthesis
console.log('=== DEEP ANALYSIS RESULTS ===\n');

console.log('--- CONTENT STRATEGY ---');
console.log(`  Core template: ${synthesis.content_strategy?.core_template}`);
console.log(`  Variations: ${synthesis.content_strategy?.template_variations?.join(' | ')}`);
console.log(`  Narrative: ${synthesis.content_strategy?.narrative_structure}`);

console.log('\n--- HOOK PATTERNS ---');
console.log(`  Dominant: ${synthesis.hook_patterns?.dominant_hook_type}`);
console.log(`  Techniques: ${synthesis.hook_patterns?.hook_techniques?.join(', ')}`);
console.log(`  Why it works: ${synthesis.hook_patterns?.hook_effectiveness_notes}`);

console.log('\n--- PRODUCTION ---');
console.log(`  Visual: ${synthesis.production_analysis?.visual_style}`);
console.log(`  Audio: ${synthesis.production_analysis?.audio_strategy}`);
console.log(`  Tools: ${synthesis.production_analysis?.tools_likely_used?.join(', ')}`);
console.log(`  AI usage: visuals=${synthesis.production_analysis?.ai_usage?.uses_ai_visuals} voice=${synthesis.production_analysis?.ai_usage?.uses_ai_voiceover} script=${synthesis.production_analysis?.ai_usage?.uses_ai_script} (${synthesis.production_analysis?.ai_usage?.ai_confidence})`);
console.log(`  Evidence: ${synthesis.production_analysis?.ai_usage?.evidence}`);
console.log(`  Time/video: ${synthesis.production_analysis?.estimated_time_per_video}`);

console.log('\n--- CONTENT SOURCE ---');
console.log(`  Type: ${synthesis.content_source_analysis?.content_type} (${synthesis.content_source_analysis?.confidence})`);
console.log(`  Source: ${synthesis.content_source_analysis?.likely_source}`);
console.log(`  Originality: ${synthesis.content_source_analysis?.originality_assessment}`);

console.log('\n--- GROWTH ANALYSIS ---');
console.log(`  Why it works:`);
for (const r of synthesis.growth_analysis?.why_it_works || []) console.log(`    - ${r}`);
console.log(`  Psychology: ${synthesis.growth_analysis?.audience_psychology}`);
console.log(`  Viral: ${synthesis.growth_analysis?.viral_mechanics}`);
console.log(`  Retention: ${synthesis.growth_analysis?.retention_tactics?.join(', ')}`);

console.log('\n--- REPLICABILITY ---');
console.log(`  Score: ${synthesis.replicability?.score}/1.0`);
console.log(`  Need: ${synthesis.replicability?.what_you_need?.join(', ')}`);
console.log(`  Time to first: ${synthesis.replicability?.time_to_first_video}`);
console.log(`  Moat: ${synthesis.replicability?.moat}`);

console.log('\n--- EXECUTIVE SUMMARY ---');
console.log(`  ${synthesis.executive_summary}`);

console.log('\n--- Raw JSON ---');
console.log(JSON.stringify(synthesis, null, 2));

// Total time
console.log(`\n${'='.repeat(80)}`);
console.log(`TOTAL PIPELINE TIME: ${((Date.now() - startAll) / 1000).toFixed(1)}s`);
console.log(`  Storyboards (${storyboards.length} parallel): ${(totalElapsed / 1000).toFixed(1)}s`);
console.log(`  Synthesis: ${(synthElapsed / 1000).toFixed(1)}s`);
console.log(`${'='.repeat(80)}`);

await pool.end();
