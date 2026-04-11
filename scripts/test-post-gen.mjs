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

const PAPAI_API_KEY = env.PAPAI_API_KEY;

// The synthesis result from our actual pipeline run
const synthesis = {
  "channel_name": "@CailinOfficial-z8l",
  "channel_url": "https://www.youtube.com/@CailinOfficial-z8l",
  "subscribers": 25200,
  "age_days": 99,
  "total_videos": 1534,
  "top_video_views": 43300768,
  "category": "Technology",
  "niche": "Mechanical Engineering",
  "content_strategy": {
    "core_template": "A 4-second, ultra-tight macro shot of a single, 'oddly satisfying' mechanical or manual task set to high-energy, rhythmic electronic music with no dialogue.",
    "template_variations": [
      "Switching from mechanical assembly to high-speed food preparation while maintaining the same rhythmic editing style.",
      "Varying the 'satisfying' element between tactile precision and visual fluid dynamics."
    ],
    "narrative_structure": "Micro-task execution: starts at the climax, setup is skipped, ends the moment the task completes. Process-as-payoff."
  },
  "hook_patterns": {
    "dominant_hook_type": "Visual Curiosity & Sensory Satisfaction",
    "hook_techniques": [
      "Extreme close-ups (macro) showing textures",
      "Defying physics/expectations",
      "High-contrast colors"
    ],
    "estimated_avg_hook_seconds": 1.5
  },
  "production_analysis": {
    "editing_patterns": "Extreme brevity (4 seconds flat); continuous shots with no cuts; designed for a perfect seamless loop.",
    "ai_usage": { "uses_ai_visuals": false, "uses_ai_voiceover": false },
    "production_difficulty": "medium"
  },
  "growth_analysis": {
    "why_it_works": [
      "Ultra-short duration (4s) guarantees high retention percentages (often >100%).",
      "Language-agnostic — appeals to global audience.",
      "Loop factor — viewers watch 2-3 times to catch details."
    ],
    "audience_psychology": "Exploits 'Completion Bias' and ASMR-adjacent tactile satisfaction.",
    "retention_tactics": [
      "Ending the video abruptly to force a re-watch.",
      "Using high-energy music to maintain arousal."
    ]
  },
  "replicability": {
    "score": 0.85
  }
};

const postGenPrompt = `You are a copywriter for @evgeniirofe on X (Twitter). We analyze YouTube Shorts channels that are blowing up and post breakdowns of HOW they work so aspiring creators can learn from them.

## OUR AUDIENCE
- Aspiring YouTube Shorts creators
- People curious about what's working on Shorts right now
- They want ACTIONABLE insights, not fluff
- They want to know: "What's the formula? Could I do this?"

## POST FORMAT RULES
- Thread of exactly 2 tweets (T1 and T2)
- T1: The MAIN post. Structure it as:
  1. FIRST LINE: The scroll-stopping stats — raw numbers that make people stop. Format: "[big view count]. [subs]. [age]. Here's the/their [formula name]:" — this line is MANDATORY
  2. MIDDLE: The formula breakdown with ▸ bullets — what exactly they do
  3. LAST LINE: "The channel name is in the thread 👇"
  DO NOT mention the channel name in T1.
- T2 is hardcoded (not AI-generated), ignore it.
- T1 can be up to 336 characters (280 + 20% buffer for X thread formatting)
- T2 should be short — under 200 characters
- Use ▸ for bullet points
- Use plain language, no corporate speak, no emojis except 👇 in T1
- Be specific — numbers, seconds, exact tactics. No vague "great content" statements
- The tone is: data-driven, slightly irreverent, like a smart friend sharing alpha
- T1 should pack maximum value — someone reading JUST T1 should learn the formula even if they never click through

## WHAT NOT TO DO
- Don't say "in the world of YouTube Shorts" or similar filler
- Don't use words like "revolutionary", "game-changing", "incredible"
- Don't describe the niche as "thriving" or "booming"
- Don't start T1 with "Thread:" or "🧵"
- Don't use more than 1 emoji total
- Don't speculate about what tools they use or how long videos take to make
- Don't waste T2 on stats or analysis — T2 is ONLY the name reveal

## DEEP ANALYSIS DATA
Here is our research on this channel. Use it to write the thread:

${JSON.stringify(synthesis, null, 2)}

Respond with a JSON object (no markdown, no code fences):

{
  "tweet": "The full T1 text here",
  "char_count": 0,
  "hook_category": "speed | niche | doable | ai | discovery"
}

Respond ONLY with the JSON object.`;

console.log(`Post generation prompt: ${postGenPrompt.length} chars\n`);

// Run it 3 times to see variation
for (let attempt = 1; attempt <= 3; attempt++) {
  console.log(`${'='.repeat(60)}`);
  console.log(`ATTEMPT ${attempt}`);
  console.log(`${'='.repeat(60)}\n`);

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
        contents: [{ parts: [{ text: postGenPrompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 },
      }),
    }
  );

  const elapsed = Date.now() - startTime;
  console.log(`Response: ${(elapsed / 1000).toFixed(1)}s (status: ${response.status})\n`);

  if (!response.ok) {
    console.error('Error:', await response.text());
    continue;
  }

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;

  let jsonStr = rawText.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const s = jsonStr.indexOf('{');
  const e = jsonStr.lastIndexOf('}');
  if (s !== -1 && e > s) jsonStr = jsonStr.substring(s, e + 1);

  let result;
  try {
    result = JSON.parse(jsonStr);
  } catch {
    console.error('Parse failed:', rawText?.substring(0, 300));
    continue;
  }

  const t1 = result.tweet;
  const len = t1.length;
  const over = len > 336 ? ` ⚠️ OVER LIMIT (max 336)` : '';
  console.log(`--- T1 (${len} chars${over}) ---`);
  console.log(t1);
  console.log('');
  console.log(`--- T2 (hardcoded) ---`);
  console.log(`${synthesis.channel_name}\n${synthesis.channel_url}\n\nFollow @evgeniirofe — we find channels like this every day.`);
  console.log('');
  console.log(`Hook category: ${result.hook_category}\n`);
}
