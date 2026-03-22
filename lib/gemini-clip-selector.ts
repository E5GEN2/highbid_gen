/**
 * AI Clip Selector — uses Gemini to pick the best clip-worthy moments
 * from the timestamped video segments produced by analysis.
 *
 * Uses the text-only PapaiAPI endpoint (no video upload needed).
 */

import type { VideoSegment } from './gemini-files';

const CLIP_SELECTION_PROMPT = `You are selecting clips from a video for YouTube Shorts.

RULES:
- Each clip MUST be between {{MIN_DURATION}} and {{MAX_DURATION}} seconds long. NO SHORTER.
- Pick 5-15 clips with the strongest hooks and self-contained narratives.
- Prefer segments with clear speech, strong visual hooks, and natural start/end points.
- Score each clip 1-10 for viral potential (be honest, not all clips are 10/10).

VIDEO SEGMENTS:
{{SEGMENTS}}

Return a JSON array with EXACTLY these field names:
[{"title":"catchy title","start":0,"end":60,"score":8,"description":"why this clip is good","transcript":"key words spoken in this clip"}]

CRITICAL: Every clip's (end - start) must be >= {{MIN_DURATION}} and <= {{MAX_DURATION}}. Clips shorter than {{MIN_DURATION}}s will be rejected.`;

export interface SelectedClip {
  title: string;
  start: number;
  end: number;
  score: number;
  description: string;
  transcript: string;
}

export interface ClipSelectionResult {
  clips: SelectedClip[];
  raw_response: string;
  tokens_in: number;
  tokens_out: number;
  duration_ms: number;
}

/**
 * Ask Gemini to select the best clips from analyzed segments.
 * Uses text-only API — no video needed, just segment data.
 */
export async function selectClips(
  segments: VideoSegment[],
  apiKey: string,
  options?: { clipLength?: string; customPrompt?: string },
): Promise<ClipSelectionResult> {
  const startTime = Date.now();

  // Parse clip length range (e.g. "60s-90s" → min=60, max=90)
  const clipLength = options?.clipLength || '60s-90s';
  const match = clipLength.match(/(\d+)s?-(\d+)/);
  const minDuration = match ? parseInt(match[1]) : 60;
  const maxDuration = match ? parseInt(match[2]) : 90;

  // Full segment data — no trimming, PapaiAPI limit is now 1MB
  const segmentText = segments.map(s =>
    `[${s.start.toFixed(1)}-${s.end.toFixed(1)}s] visual: ${s.visual} | speech: ${s.speech || '(none)'} | audio: ${s.audio || '(none)'}`
  ).join('\n');

  const promptTemplate = options?.customPrompt || CLIP_SELECTION_PROMPT;
  const prompt = promptTemplate
    .replace('{{SEGMENTS}}', segmentText)
    .replace(/\{\{MIN_DURATION\}\}/g, String(minDuration))
    .replace(/\{\{MAX_DURATION\}\}/g, String(maxDuration));

  // Use generateContent with responseMimeType for reliable JSON output
  const MAX_ATTEMPTS = 3;
  let text = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let durationMs = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const attemptStart = Date.now();
    const response = await fetch('https://papaiapi.com/v1beta/models/gemini-flash:generateContent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 8192,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (attempt < MAX_ATTEMPTS) { console.log(`[clip-selector] Attempt ${attempt} failed: ${response.status}`); continue; }
      throw new Error(`Gemini API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    durationMs += Date.now() - attemptStart;
    tokensIn += data.usageMetadata?.promptTokenCount || 0;
    tokensOut += data.usageMetadata?.candidatesTokenCount || 0;

    text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (text) break;

    console.log(`[clip-selector] Attempt ${attempt}/${MAX_ATTEMPTS}: empty response`);
  }

  if (!text) {
    throw new Error('No text in Gemini clip selection response after retries');
  }

  // Parse JSON — clean up and extract array
  let jsonStr = text
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .trim();

  // Try direct parse first (response might be clean JSON)
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    // Extract from first [ to last ]
    const arrStart = jsonStr.indexOf('[');
    const arrEnd = jsonStr.lastIndexOf(']');
    if (arrStart !== -1 && arrEnd > arrStart) {
      try {
        parsed = JSON.parse(jsonStr.substring(arrStart, arrEnd + 1));
      } catch {
        throw new Error(`Failed to parse clip selection JSON: ${jsonStr.substring(0, 500)}`);
      }
    } else {
      throw new Error(`No JSON array found in response: ${jsonStr.substring(0, 500)}`);
    }
  }

  // Handle both array and {clips:[...]} wrapper
  let rawClips: Record<string, unknown>[];
  if (Array.isArray(parsed)) {
    rawClips = parsed;
  } else if (parsed && typeof parsed === 'object' && 'clips' in (parsed as Record<string, unknown>)) {
    rawClips = (parsed as Record<string, unknown>).clips as Record<string, unknown>[];
  } else {
    throw new Error('Clip selection response is not an array or {clips:[]}');
  }

  // Validate and clean — accept score OR content_score
  const clips: SelectedClip[] = rawClips
    .filter((c: Record<string, unknown>) => c.start != null && c.end != null && Number(c.end) > Number(c.start))
    .map((c: Record<string, unknown>) => ({
      title: String(c.title || 'Untitled Clip'),
      start: Number(c.start),
      end: Number(c.end),
      score: Math.min(10, Math.max(1, Number(c.score || c.content_score || c.viral_score || c.viral_potential) || 5)),
      description: String(c.description || c.reason || ''),
      transcript: String(c.transcript || c.hook || c.speech || ''),
    }))
    .sort((a, b) => b.score - a.score);

  return { clips, raw_response: text, tokens_in: tokensIn, tokens_out: tokensOut, duration_ms: durationMs };
}

export { CLIP_SELECTION_PROMPT };
