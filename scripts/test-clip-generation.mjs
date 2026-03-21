#!/usr/bin/env node
/**
 * Test script for clip generation pipeline.
 * Usage: node scripts/test-clip-generation.mjs <projectId> [--cut]
 *
 * Tests:
 * 1. Load segments from DB
 * 2. AI clip selection via Gemini
 * 3. (optional --cut) ffmpeg clip cutting from source video
 */

import fs from 'fs';
import path from 'path';
import pg from 'pg';
import { execSync } from 'child_process';

// Load env
const envPath = path.join(process.cwd(), '.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
  const [key, ...rest] = line.split('=');
  if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
}

const API_KEY = process.env.PAPAI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

async function main() {
  const args = process.argv.slice(2);
  const projectId = args.find(a => !a.startsWith('--'));
  const doCut = args.includes('--cut');

  if (!projectId) {
    console.error('Usage: node scripts/test-clip-generation.mjs <projectId> [--cut]');
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // 1. Load segments
  console.log('\n=== Loading segments ===');
  const analysisRes = await pool.query(
    `SELECT id, segments, video_url, video_duration_seconds
     FROM clipping_analyses WHERE project_id = $1 AND status = 'done'
     ORDER BY created_at DESC LIMIT 1`,
    [projectId]
  );

  if (analysisRes.rows.length === 0) {
    console.error('No completed analysis found for this project');
    process.exit(1);
  }

  const analysis = analysisRes.rows[0];
  const segments = analysis.segments;
  console.log(`Analysis: ${analysis.id}`);
  console.log(`Segments: ${segments.length}`);
  console.log(`Duration: ${analysis.video_duration_seconds}s`);
  console.log(`Video URL: ${analysis.video_url}`);

  // 2. AI clip selection
  console.log('\n=== AI Clip Selection ===');
  const startTime = Date.now();

  // Format segments for prompt
  const segmentText = segments.map(s =>
    `[${s.start.toFixed(1)}-${s.end.toFixed(1)}s] visual: ${s.visual} | speech: ${s.speech || '(none)'} | audio: ${s.audio || '(none)'}`
  ).join('\n');

  const prompt = `You are a professional video editor. Given the timestamped segments of a video, identify the best standalone clips that would work as short-form content (YouTube Shorts, TikTok, Reels).

Rules:
- Each clip should be 30-90 seconds long
- Pick 5-15 of the best moments
- Each clip must have a strong hook in the first 5 seconds
- Clips should be self-contained — they make sense without context
- Prefer segments with clear speech, strong visuals, or emotional peaks
- Score each clip 1-10 based on viral potential
- Generate a catchy title for each clip
- Include the full transcript (concatenate speech from all segments in the clip)
- Include a 1-2 sentence description of why this clip is good

Here are the video segments:

${segmentText}

Respond with ONLY this JSON array, no other text:
[{"title":"...","start":<seconds>,"end":<seconds>,"score":<1-10>,"description":"...","transcript":"..."}]`;

  console.log(`Prompt length: ${prompt.length} chars`);

  const response = await fetch(
    'https://papaiapi.com/v1beta/models/gemini-flash:generateContent',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': API_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 8192 },
      }),
    }
  );

  if (!response.ok) {
    console.error(`API error ${response.status}: ${await response.text()}`);
    process.exit(1);
  }

  const data = await response.json();
  const durationMs = Date.now() - startTime;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  const tokensIn = data.usageMetadata?.promptTokenCount || 0;
  const tokensOut = data.usageMetadata?.candidatesTokenCount || 0;

  console.log(`API time: ${durationMs}ms`);
  console.log(`Tokens: ${tokensIn} in / ${tokensOut} out`);

  // Parse clips
  let jsonStr = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
  const arrStart = jsonStr.indexOf('[');
  const arrEnd = jsonStr.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) jsonStr = jsonStr.substring(arrStart, arrEnd + 1);

  const clips = JSON.parse(jsonStr);
  console.log(`\nSelected ${clips.length} clips:\n`);

  for (const clip of clips) {
    const dur = (clip.end - clip.start).toFixed(0);
    console.log(`  #${clips.indexOf(clip) + 1} [${clip.score}/10] "${clip.title}"`);
    console.log(`     ${clip.start}s - ${clip.end}s (${dur}s)`);
    console.log(`     ${clip.description}`);
    console.log(`     transcript: "${clip.transcript?.substring(0, 80)}..."`);
    console.log();
  }

  // 3. Optional: cut clips
  if (doCut) {
    const videoUrl = analysis.video_url;
    console.log('\n=== Cutting clips ===');

    // Check if source is a local file
    let sourcePath;
    if (videoUrl.startsWith('file://')) {
      sourcePath = videoUrl.replace('file://', '');
    } else {
      console.log('Downloading source video...');
      sourcePath = `/tmp/clips/${projectId}/source.mp4`;
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      if (!fs.existsSync(sourcePath)) {
        execSync(`curl -L -o "${sourcePath}" "${videoUrl}"`, { stdio: 'pipe' });
      }
    }

    if (!fs.existsSync(sourcePath)) {
      console.error(`Source video not found: ${sourcePath}`);
      process.exit(1);
    }

    const clipDir = `/tmp/clips/${projectId}`;
    fs.mkdirSync(clipDir, { recursive: true });

    for (const clip of clips) {
      const idx = clips.indexOf(clip) + 1;
      const clipFile = path.join(clipDir, `clip_${idx}.mp4`);
      const thumbFile = path.join(clipDir, `clip_${idx}.jpg`);
      const duration = clip.end - clip.start;

      console.log(`  Cutting clip ${idx}: ${clip.start}s-${clip.end}s (${duration.toFixed(0)}s)...`);

      try {
        execSync(
          `ffmpeg -ss ${clip.start} -i "${sourcePath}" -t ${duration} -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -movflags +faststart -y "${clipFile}"`,
          { stdio: 'pipe', timeout: 120000 }
        );

        const size = fs.statSync(clipFile).size;
        console.log(`    OK: ${(size / 1e6).toFixed(1)}MB`);

        // Thumbnail
        execSync(
          `ffmpeg -ss ${clip.start + 2} -i "${sourcePath}" -vframes 1 -q:v 5 -y "${thumbFile}"`,
          { stdio: 'pipe', timeout: 30000 }
        );
      } catch (err) {
        console.error(`    FAILED: ${err.message}`);
      }
    }

    console.log(`\nClips saved to: ${clipDir}`);
  }

  await pool.end();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
