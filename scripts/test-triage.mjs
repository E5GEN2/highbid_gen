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

// Step 1: Fetch 30 channels that have existing analysis
console.log('--- Fetching 30 analyzed channels from DB ---\n');

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
  INNER JOIN channel_analysis ca ON ca.channel_id = sc.channel_id AND ca.status = 'done'
  WHERE sc.subscriber_count > 5000
    AND sc.channel_creation_date > NOW() - INTERVAL '180 days'
  ORDER BY sc.subscriber_count DESC
  LIMIT 30
`);

console.log(`Found ${channels.length} channels with analysis data\n`);

// Print summary
for (const ch of channels) {
  console.log(`  ${ch.channel_name} | ${ch.category} > ${ch.niche} > ${ch.sub_niche || '-'} | ${ch.content_style} | ${Number(ch.subscriber_count).toLocaleString()} subs | ${ch.age_days}d old | AI: ${ch.is_ai_generated ?? '?'} | Top vid: ${Number(ch.top_video_views).toLocaleString()} views`);
}

// Step 2: Build triage prompt
console.log('\n--- Building triage prompt ---\n');

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

const triagePrompt = `You are a YouTube Shorts analyst. Below are ${channels.length} channels we discovered recently. Each has basic analysis data.

Your job: Pick the TOP 8 channels that would be MOST INTERESTING for a deep-dive video-by-video analysis. We want to understand their content strategy, production methods, and what makes them grow.

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

${JSON.stringify(channelSummaries, null, 2)}

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

console.log(`Prompt length: ${triagePrompt.length} chars\n`);

// Step 3: Call Gemini
console.log('--- Calling Gemini for triage ---\n');

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
      contents: [{ parts: [{ text: triagePrompt }] }],
      generationConfig: {
        temperature: 0.4,
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
  process.exit(1);
}

const data = await response.json();
const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;

if (!rawText) {
  console.error('No text in response:', JSON.stringify(data, null, 2));
  process.exit(1);
}

// Parse JSON
let jsonStr = rawText
  .replace(/```(?:json)?\s*/gi, '')
  .replace(/```/g, '')
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
  console.error('Failed to parse JSON response:');
  console.error(rawText);
  process.exit(1);
}

// Print results
console.log('=== TRIAGE RESULTS ===\n');

for (const sel of result.selected || []) {
  console.log(`#${sel.priority} [${sel.interest_score}] ${sel.channel_name}`);
  console.log(`   ${sel.channel_url}`);
  console.log(`   WHY: ${sel.reason}`);
  console.log(`   LOOK FOR: ${sel.what_to_look_for}`);
  console.log('');
}

console.log(`SKIPPED: ${result.skipped_summary}\n`);

// Also dump raw JSON for inspection
console.log('--- Raw JSON output ---');
console.log(JSON.stringify(result, null, 2));

await pool.end();
