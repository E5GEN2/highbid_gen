#!/usr/bin/env node
/**
 * Test script for clipping video analysis pipeline.
 * Usage: node scripts/test-clipping.mjs [video_path] [--chunks]
 *
 * Tests:
 * 1. Multipart file upload to PapaiAPI
 * 2. Full analysis prompt parsing
 * 3. Chunked analysis for long videos
 * 4. Retry logic on failure
 * 5. DB storage
 */

import fs from 'fs';
import path from 'path';
import pg from 'pg';

// Load env
const envPath = path.join(process.cwd(), '.env.local');
const envContent = fs.readFileSync(envPath, 'utf-8');
for (const line of envContent.split('\n')) {
  const [key, ...rest] = line.split('=');
  if (key && rest.length) process.env[key.trim()] = rest.join('=').trim();
}

const API_KEY = process.env.PAPAI_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const API_URL = 'https://papaiapi.com/v1/files/chat';

const CHUNK_DURATION = 5 * 60; // 5 minutes

// --- Analysis prompt ---
const ANALYSIS_PROMPT = `Analyze this video. Break it into 2-4 second segments covering every second. For each segment provide start/end in seconds, visual description, exact speech transcription (word-for-word, "" if none), and audio notes ("" if nothing notable). Timestamps must be continuous with no gaps. Respond with ONLY this JSON, no other text: {"video_duration_seconds":<total>,"segments":[{"start":0.0,"end":3.0,"visual":"...","speech":"...","audio":"..."}]}`;

function makeChunkPrompt(startSec, endSec) {
  return `Analyze ONLY the portion from ${startSec}s to ${endSec}s of this video. Break it into 2-4 second segments. Use ABSOLUTE timestamps (from video start, not relative). First segment starts at ${startSec}s, last ends at ${endSec}s. For each: start/end seconds, visual description, exact speech ("" if none), audio notes ("" if nothing). Respond with ONLY JSON: {"video_duration_seconds":${endSec - startSec},"segments":[{"start":${startSec}.0,"end":...,"visual":"...","speech":"...","audio":"..."}]}`;
}

// --- API call with multipart upload ---
async function callApi(filePath, prompt, retries = 3) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      console.log(`  [API] Attempt ${attempt}/${retries}...`);
      const startTime = Date.now();

      const fileBuffer = fs.readFileSync(filePath);
      const fileName = path.basename(filePath);

      // Build multipart form data manually
      const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
      const parts = [];

      // File part
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        `Content-Type: video/mp4\r\n\r\n`
      );
      parts.push(fileBuffer);
      parts.push('\r\n');

      // Prompt part
      parts.push(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="prompt"\r\n\r\n` +
        `${prompt}\r\n`
      );

      parts.push(`--${boundary}--\r\n`);

      // Combine into single buffer
      const bodyParts = parts.map(p => typeof p === 'string' ? Buffer.from(p) : p);
      const body = Buffer.concat(bodyParts);

      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      });

      const durationMs = Date.now() - startTime;

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`API ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new Error('No content in response');

      console.log(`  [API] Success in ${durationMs}ms, tokens: ${data.usage?.prompt_tokens || '?'}/${data.usage?.completion_tokens || '?'}`);

      return {
        content,
        tokens_in: data.usage?.prompt_tokens || 0,
        tokens_out: data.usage?.completion_tokens || 0,
        duration_ms: durationMs,
      };
    } catch (err) {
      console.error(`  [API] Attempt ${attempt} failed: ${err.message}`);
      if (attempt === retries) throw err;
      const delay = attempt * 5000;
      console.log(`  [API] Retrying in ${delay / 1000}s...`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// --- Parse JSON response ---
function parseAnalysis(text) {
  let jsonStr = text
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .trim();

  const start = jsonStr.indexOf('{');
  const end = jsonStr.lastIndexOf('}');
  if (start !== -1 && end > start) jsonStr = jsonStr.substring(start, end + 1);

  const parsed = JSON.parse(jsonStr);
  if (!parsed.segments || !Array.isArray(parsed.segments)) {
    throw new Error('Missing segments array');
  }
  return parsed;
}

// --- Get video duration via ffprobe ---
async function getVideoDuration(filePath) {
  const { execSync } = await import('child_process');
  const output = execSync(
    `ffprobe -v quiet -print_format json -show_format "${filePath}"`,
    { encoding: 'utf-8' }
  );
  return parseFloat(JSON.parse(output).format.duration);
}

// --- Plan chunks ---
function planChunks(durationSec) {
  if (durationSec <= CHUNK_DURATION) {
    return [{ index: 0, startSec: 0, endSec: durationSec, label: 'Full video' }];
  }
  const chunks = [];
  let start = 0, i = 0;
  while (start < durationSec) {
    const end = Math.min(start + CHUNK_DURATION, durationSec);
    const startTs = `${Math.floor(start / 60)}:${String(Math.floor(start % 60)).padStart(2, '0')}`;
    const endTs = `${Math.floor(end / 60)}:${String(Math.floor(end % 60)).padStart(2, '0')}`;
    chunks.push({ index: i, startSec: start, endSec: end, label: `${startTs}–${endTs}` });
    start = end;
    i++;
  }
  return chunks;
}

// --- Main ---
async function main() {
  const args = process.argv.slice(2);
  const videoPath = args.find(a => !a.startsWith('--')) || '/tmp/test_clip_30s.mp4';
  const useChunks = args.includes('--chunks');

  if (!fs.existsSync(videoPath)) {
    console.error(`File not found: ${videoPath}`);
    process.exit(1);
  }

  console.log(`\n=== Clipping Analysis Test ===`);
  console.log(`Video: ${videoPath}`);

  const duration = await getVideoDuration(videoPath);
  console.log(`Duration: ${duration.toFixed(1)}s (${(duration / 60).toFixed(1)}min)`);
  console.log(`Size: ${(fs.statSync(videoPath).size / 1e6).toFixed(1)}MB`);

  const chunks = useChunks ? planChunks(duration) : [{ index: 0, startSec: 0, endSec: duration, label: 'Full video' }];
  console.log(`Chunks: ${chunks.length}`);
  chunks.forEach(c => console.log(`  ${c.index + 1}. ${c.label} (${(c.endSec - c.startSec).toFixed(0)}s)`));

  // Connect to DB
  const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  // Create test project
  const projectRes = await pool.query(
    `INSERT INTO clipping_projects (title, status) VALUES ($1, 'processing') RETURNING id`,
    [`test-${Date.now()}`]
  );
  const projectId = projectRes.rows[0].id;
  console.log(`\nProject: ${projectId}`);

  // Create analysis record
  const analysisRes = await pool.query(
    `INSERT INTO clipping_analyses (project_id, video_url, status, prompt)
     VALUES ($1, $2, 'processing', 'test') RETURNING id`,
    [projectId, `file://${videoPath}`]
  );
  const analysisId = analysisRes.rows[0].id;
  console.log(`Analysis: ${analysisId}`);

  const allSegments = [];
  let totalTokensIn = 0, totalTokensOut = 0, totalDurationMs = 0;
  const rawParts = [];
  const failedChunks = [];

  for (const chunk of chunks) {
    console.log(`\n--- Chunk ${chunk.index + 1}/${chunks.length}: ${chunk.label} ---`);

    const prompt = chunk.label === 'Full video'
      ? ANALYSIS_PROMPT
      : makeChunkPrompt(chunk.startSec, chunk.endSec);

    // For chunked analysis, extract the chunk as a separate file
    let chunkFile = videoPath;
    if (chunks.length > 1) {
      chunkFile = `/tmp/clip_chunk_${chunk.index}.mp4`;
      if (!fs.existsSync(chunkFile)) {
        console.log(`  Extracting chunk ${chunk.startSec}s-${chunk.endSec}s...`);
        const { execSync } = await import('child_process');
        execSync(
          `ffmpeg -i "${videoPath}" -ss ${chunk.startSec} -t ${chunk.endSec - chunk.startSec} -c:v libx264 -c:a aac -y "${chunkFile}"`,
          { stdio: 'pipe' }
        );
        const chunkSize = fs.statSync(chunkFile).size / 1e6;
        console.log(`  Chunk file: ${chunkSize.toFixed(1)}MB`);
      }
    }

    // Log start
    await pool.query(
      `INSERT INTO clipping_logs (project_id, analysis_id, step, status, message, data)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [projectId, analysisId, 'process_chunk', 'active',
       `Starting chunk ${chunk.index + 1}/${chunks.length}: ${chunk.label}`,
       JSON.stringify({ chunkIndex: chunk.index, startSec: chunk.startSec, endSec: chunk.endSec })]
    );

    try {
      const result = await callApi(chunkFile, prompt, 3);
      const analysis = parseAnalysis(result.content);

      console.log(`  Segments: ${analysis.segments.length}`);
      console.log(`  Duration reported: ${analysis.video_duration_seconds}s`);
      if (analysis.segments.length > 0) {
        const first = analysis.segments[0];
        const last = analysis.segments[analysis.segments.length - 1];
        console.log(`  First: ${first.start}s - "${first.speech?.substring(0, 50) || '(no speech)'}"`);
        console.log(`  Last: ${last.start}-${last.end}s`);
      }

      allSegments.push(...analysis.segments);
      totalTokensIn += result.tokens_in;
      totalTokensOut += result.tokens_out;
      totalDurationMs += result.duration_ms;
      rawParts.push(result.content);

      // Log success
      await pool.query(
        `INSERT INTO clipping_logs (project_id, analysis_id, step, status, message, data)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [projectId, analysisId, 'process_chunk', 'done',
         `Chunk ${chunk.index + 1} done: ${analysis.segments.length} segments in ${result.duration_ms}ms`,
         JSON.stringify({
           chunkIndex: chunk.index, segments: analysis.segments.length,
           tokens_in: result.tokens_in, tokens_out: result.tokens_out,
           duration_ms: result.duration_ms
         })]
      );
    } catch (err) {
      console.error(`  FAILED: ${err.message}`);
      failedChunks.push(chunk);

      await pool.query(
        `INSERT INTO clipping_logs (project_id, analysis_id, step, status, message, data)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [projectId, analysisId, 'process_chunk', 'error',
         `Chunk ${chunk.index + 1} failed: ${err.message}`,
         JSON.stringify({ chunkIndex: chunk.index, error: err.message })]
      );
    }
  }

  // Sort segments by start time
  allSegments.sort((a, b) => a.start - b.start);
  const maxEnd = allSegments.length > 0 ? allSegments[allSegments.length - 1].end : 0;

  // Store results
  const status = failedChunks.length === 0 ? 'done' : 'partial';
  await pool.query(
    `UPDATE clipping_analyses SET
      status = $1,
      video_duration_seconds = $2,
      total_segments = $3,
      segments = $4,
      raw_response = $5,
      tokens_in = $6,
      tokens_out = $7,
      duration_ms = $8,
      error = $9,
      completed_at = NOW()
    WHERE id = $10`,
    [
      status, maxEnd, allSegments.length,
      JSON.stringify(allSegments),
      rawParts.join('\n\n---CHUNK_BOUNDARY---\n\n'),
      totalTokensIn, totalTokensOut, totalDurationMs,
      failedChunks.length > 0 ? `Failed chunks: ${failedChunks.map(c => c.label).join(', ')}` : null,
      analysisId,
    ]
  );

  await pool.query(
    `UPDATE clipping_projects SET status = $1, updated_at = NOW() WHERE id = $2`,
    [status, projectId]
  );

  console.log(`\n=== Results ===`);
  console.log(`Status: ${status}`);
  console.log(`Total segments: ${allSegments.length}`);
  console.log(`Video duration: ${maxEnd.toFixed(1)}s`);
  console.log(`Total tokens: ${totalTokensIn} in / ${totalTokensOut} out`);
  console.log(`Total API time: ${(totalDurationMs / 1000).toFixed(1)}s`);
  if (failedChunks.length > 0) {
    console.log(`Failed chunks: ${failedChunks.map(c => c.label).join(', ')}`);
  }
  console.log(`\nProject ID: ${projectId}`);
  console.log(`Analysis ID: ${analysisId}`);
  console.log(`Debug: /api/clipping/debug?projectId=${projectId}`);

  await pool.end();
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
