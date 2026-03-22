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

  // Format segments compactly for the prompt
  const segmentText = segments.map(s =>
    `[${s.start.toFixed(1)}-${s.end.toFixed(1)}s] visual: ${s.visual} | speech: ${s.speech || '(none)'} | audio: ${s.audio || '(none)'}`
  ).join('\n');

  const promptTemplate = customPrompt || CLIP_SELECTION_PROMPT;
  const prompt = promptTemplate.replace('{{SEGMENTS}}', segmentText);

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
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 8192,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const durationMs = Date.now() - startTime;

  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    throw new Error('No text in Gemini clip selection response');
  }

  const tokensIn = data.usageMetadata?.promptTokenCount || 0;
  const tokensOut = data.usageMetadata?.candidatesTokenCount || 0;

  // Parse JSON response
  let jsonStr = text
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    .trim();

  // Extract JSON array — find the actual [{"title":... pattern, not any random [
  let clips: SelectedClip[];
  try {
    // Try finding [{ which indicates start of JSON array of objects
    const jsonArrayStart = jsonStr.indexOf('[{');
    const jsonArrayEnd = jsonStr.lastIndexOf('}]');
    if (jsonArrayStart !== -1 && jsonArrayEnd > jsonArrayStart) {
      jsonStr = jsonStr.substring(jsonArrayStart, jsonArrayEnd + 2);
    } else {
      // Fallback: try first [ to last ]
      const arrStart = jsonStr.indexOf('[');
      const arrEnd = jsonStr.lastIndexOf(']');
      if (arrStart !== -1 && arrEnd > arrStart) {
        jsonStr = jsonStr.substring(arrStart, arrEnd + 1);
      }
    }
    clips = JSON.parse(jsonStr);
  } catch {
    throw new Error(`Failed to parse clip selection JSON: ${jsonStr.substring(0, 500)}`);
  }

  if (!Array.isArray(clips)) {
    throw new Error('Clip selection response is not an array');
  }

  // Validate and clean clips
  clips = clips
    .filter(c => c.start != null && c.end != null && c.end > c.start)
    .map(c => ({
      title: c.title || 'Untitled Clip',
      start: Number(c.start),
      end: Number(c.end),
      score: Math.min(10, Math.max(1, Number(c.score) || 5)),
      description: c.description || '',
      transcript: c.transcript || '',
    }))
    .sort((a, b) => b.score - a.score); // Highest score first

  return { clips, raw_response: text, tokens_in: tokensIn, tokens_out: tokensOut, duration_ms: durationMs };
}

export { CLIP_SELECTION_PROMPT };
