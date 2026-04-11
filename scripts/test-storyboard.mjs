import pg from 'pg';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env.local
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

// Pick a channel from triage winners - let's test with @CapyEscapes (AI content) and @MrOlllex (fast growth)
const TEST_CHANNELS = ['@CapyEscapes', '@MrOlllex'];

for (const handle of TEST_CHANNELS) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`CHANNEL: ${handle}`);
  console.log(`${'='.repeat(80)}\n`);

  // Get channel info
  const { rows: [channel] } = await pool.query(`
    SELECT sc.channel_id, sc.channel_name, sc.channel_url,
           ca.channel_summary, ca.niche, ca.content_style
    FROM shorts_channels sc
    LEFT JOIN channel_analysis ca ON ca.channel_id = sc.channel_id
    WHERE sc.channel_url LIKE $1
    LIMIT 1
  `, [`%/${handle}%`]);

  if (!channel) {
    console.log(`Channel not found: ${handle}`);
    continue;
  }

  // Get top 5 videos by views (3 top + 2 most recent, deduplicated)
  const { rows: topVids } = await pool.query(`
    SELECT DISTINCT ON (video_id) video_id, title, view_count, duration_seconds
    FROM shorts_videos
    WHERE channel_id = $1
    ORDER BY video_id, view_count DESC
  `, [channel.channel_id]);

  // Sort by views desc, pick top 3
  const byViews = [...topVids].sort((a, b) => Number(b.view_count) - Number(a.view_count));
  const top3 = byViews.slice(0, 3);

  // Pick 2 most recent that aren't already in top3
  const top3Ids = new Set(top3.map(v => v.video_id));
  const recent2 = byViews.filter(v => !top3Ids.has(v.video_id)).slice(0, 2);

  const selectedVideos = [...top3, ...recent2];

  console.log(`Found ${topVids.length} unique videos, selected ${selectedVideos.length}:`);
  for (const v of selectedVideos) {
    console.log(`  ${v.video_id} | ${v.title?.substring(0, 50)} | ${Number(v.view_count).toLocaleString()} views | ${v.duration_seconds}s`);
  }

  // Test storyboard on the TOP video only (to save API calls)
  const testVideo = selectedVideos[0];
  const videoUrl = `https://www.youtube.com/shorts/${testVideo.video_id}`;

  console.log(`\n--- Storyboarding: ${videoUrl} ---\n`);

  // Context from triage (what_to_look_for) - hardcoded from our triage results
  const triageContext = handle === '@CapyEscapes'
    ? "Analyze the consistency of the AI character design across videos and the specific narrative hooks used to keep viewers invested in a fictional capybara's life."
    : "Identify the 'oddly satisfying' or 'shock' elements in the first 3 seconds of the videos that contribute to such a rapid subscriber conversion rate.";

  const storyboardPrompt = `You are analyzing a YouTube Short video for a content strategy research project.

Watch this video carefully: ${videoUrl}

Channel context: ${channel.channel_name} — ${channel.channel_summary || 'No summary available'}
Research focus: ${triageContext}

Create a detailed storyboard of this video. For each distinct segment, capture what is happening visually, aurally, and strategically.

Respond with a JSON object (no markdown, no code fences) with these fields:

{
  "video_id": "${testVideo.video_id}",
  "video_url": "${videoUrl}",
  "duration_seconds": ${testVideo.duration_seconds || 'null'},
  "storyboard": [
    {
      "timestamp": "00:00 - 00:03",
      "visual_description": "Detailed description of what is shown on screen",
      "action": "What is happening / what changes",
      "text_on_screen": "Any text overlays, captions, or titles visible (null if none)",
      "audio": "Description of music, sound effects, voiceover type (TTS, human, none)",
      "dialogue": "Any spoken words (null if none)",
      "strategic_purpose": "Why this segment exists (hook, build tension, payoff, CTA, etc.)"
    }
  ],
  "hook_analysis": {
    "type": "question | bold_claim | visual_shock | curiosity_gap | pattern_interrupt | emotional | other",
    "description": "How the first 1-3 seconds grab attention",
    "estimated_hook_duration_seconds": 2
  },
  "ending_analysis": {
    "type": "cliffhanger | CTA | loop | punchline | fade | abrupt | other",
    "description": "How the video ends and whether it encourages replay or follow"
  },
  "production_notes": {
    "editing_style": "fast_cuts | slow_reveal | continuous | montage | other",
    "uses_tts": true,
    "tts_voice_type": "male | female | robotic | none",
    "uses_background_music": true,
    "music_genre": "e.g. dramatic orchestral, lo-fi, phonk, none",
    "uses_ai_visuals": true,
    "visual_source": "ai_generated | screen_recording | real_footage | stock | mixed",
    "caption_style": "animated_word_by_word | static_subtitles | none | other",
    "estimated_production_effort": "low | medium | high"
  },
  "content_template": "A one-sentence description of the repeatable formula this video follows, e.g. 'Hook question → AI animation of scenario → dramatic reveal → cliffhanger ending'"
}

Be precise with timestamps. If you cannot see the video, still attempt to analyze based on the thumbnail and any available metadata, but note that in your response.

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
        contents: [{ parts: [{ text: storyboardPrompt }] }],
        generationConfig: {
          temperature: 0.3,
          maxOutputTokens: 4096,
        },
      }),
    }
  );

  const elapsed = Date.now() - startTime;
  console.log(`Gemini responded in ${(elapsed / 1000).toFixed(1)}s (status: ${response.status})\n`);

  if (!response.ok) {
    const errText = await response.text();
    console.error('API Error:', errText);
    continue;
  }

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!rawText) {
    console.error('No text in response:', JSON.stringify(data, null, 2));
    continue;
  }

  // Parse JSON
  let jsonStr = rawText
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .trim();

  const start = jsonStr.indexOf('{');
  const end = jsonStr.lastIndexOf('}');
  if (start !== -1 && end > start) {
    jsonStr = jsonStr.substring(start, end + 1);
  }

  let result;
  try {
    result = JSON.parse(jsonStr);
  } catch (e) {
    console.error('Failed to parse JSON:');
    console.error(rawText.substring(0, 500));
    continue;
  }

  // Pretty print
  console.log('--- STORYBOARD ---\n');
  for (const seg of result.storyboard || []) {
    console.log(`[${seg.timestamp}]`);
    console.log(`  Visual: ${seg.visual_description}`);
    console.log(`  Action: ${seg.action}`);
    if (seg.text_on_screen) console.log(`  Text: ${seg.text_on_screen}`);
    console.log(`  Audio: ${seg.audio}`);
    if (seg.dialogue) console.log(`  Dialogue: "${seg.dialogue}"`);
    console.log(`  Purpose: ${seg.strategic_purpose}`);
    console.log('');
  }

  console.log('--- HOOK ---');
  console.log(`  Type: ${result.hook_analysis?.type}`);
  console.log(`  ${result.hook_analysis?.description}`);
  console.log(`  Duration: ${result.hook_analysis?.estimated_hook_duration_seconds}s\n`);

  console.log('--- ENDING ---');
  console.log(`  Type: ${result.ending_analysis?.type}`);
  console.log(`  ${result.ending_analysis?.description}\n`);

  console.log('--- PRODUCTION ---');
  const pn = result.production_notes || {};
  console.log(`  Editing: ${pn.editing_style} | TTS: ${pn.uses_tts} (${pn.tts_voice_type}) | Music: ${pn.music_genre}`);
  console.log(`  AI visuals: ${pn.uses_ai_visuals} | Source: ${pn.visual_source} | Captions: ${pn.caption_style}`);
  console.log(`  Effort: ${pn.estimated_production_effort}\n`);

  console.log(`--- TEMPLATE ---`);
  console.log(`  ${result.content_template}\n`);

  console.log('--- Raw JSON ---');
  console.log(JSON.stringify(result, null, 2));
}

await pool.end();
