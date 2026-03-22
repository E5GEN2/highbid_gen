/**
 * AI Clip Selector — uses Gemini to pick the best clip-worthy moments
 * from the timestamped video segments produced by analysis.
 *
 * Uses the text-only PapaiAPI endpoint (no video upload needed).
 */

import type { VideoSegment } from './gemini-files';

const CLIP_SELECTION_PROMPT = `Given video segments below, pick 5-15 best clips for YouTube Shorts (30-90s each). Strong hooks, self-contained, clear speech preferred. Score 1-10 for viral potential.

{{SEGMENTS}}

OUTPUT ONLY A VALID JSON ARRAY. No text before or after. No markdown. No numbering. Start your response with [{ and end with }].
[{"title":"catchy title","start":0,"end":30,"score":8,"description":"why this clip is good","transcript":"exact words spoken"}]`;

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
  customPrompt?: string,
): Promise<ClipSelectionResult> {
  const startTime = Date.now();

  // Full segment data — no trimming, PapaiAPI limit is now 1MB
  const segmentText = segments.map(s =>
    `[${s.start.toFixed(1)}-${s.end.toFixed(1)}s] visual: ${s.visual} | speech: ${s.speech || '(none)'} | audio: ${s.audio || '(none)'}`
  ).join('\n');

  const promptTemplate = customPrompt || CLIP_SELECTION_PROMPT;
  const prompt = promptTemplate.replace('{{SEGMENTS}}', segmentText);

  // Retry up to 3 times — Gemini sometimes returns text instead of JSON
  const MAX_ATTEMPTS = 3;
  let text = '';
  let tokensIn = 0;
  let tokensOut = 0;
  let durationMs = 0;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const attemptStart = Date.now();
    const response = await fetch('https://papaiapi.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gemini-flash',
        messages: [{ role: 'user', content: prompt }],
        temperature: attempt === 1 ? 0.3 : 0.1, // Lower temp on retry
        max_tokens: 8192,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (attempt < MAX_ATTEMPTS) { console.log(`[clip-selector] Attempt ${attempt} failed: ${response.status}`); continue; }
      throw new Error(`Gemini API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    durationMs += Date.now() - attemptStart;
    tokensIn += data.usage?.prompt_tokens || 0;
    tokensOut += data.usage?.completion_tokens || 0;

    text = data.choices?.[0]?.message?.content || '';

    // Check if response contains JSON
    const trimmed = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      break; // Looks like JSON
    }

    console.log(`[clip-selector] Attempt ${attempt}/${MAX_ATTEMPTS}: response not JSON, starts with "${trimmed.substring(0, 40)}..."`);
    if (attempt === MAX_ATTEMPTS) break; // Use whatever we got
  }

  if (!text) {
    throw new Error('No text in Gemini clip selection response after retries');
  }

  const tokensInFinal = tokensIn;

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
      score: Math.min(10, Math.max(1, Number(c.score || c.content_score || c.viral_score) || 5)),
      description: String(c.description || ''),
      transcript: String(c.transcript || ''),
    }))
    .sort((a, b) => b.score - a.score);

  return { clips, raw_response: text, tokens_in: tokensIn, tokens_out: tokensOut, duration_ms: durationMs };
}

export { CLIP_SELECTION_PROMPT };
