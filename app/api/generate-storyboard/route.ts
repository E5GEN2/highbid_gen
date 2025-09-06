import { NextRequest, NextResponse } from 'next/server';

const STORYBOARD_PROMPT = `SYSTEM:
You are a storyboard generator.
You must output exactly 30 lines of JSON (JSONL format). 
Each line must be a valid JSON object conforming to the schema below.
No prose, no explanations, no comments, no markdown formatting, no code blocks.

REQUIRED FIELDS:
{
  "scene_id": int (1..30),
  "start_ms": int (2000*(scene_id-1)),
  "end_ms": int (start_ms+2000),
  "beat": one of ["hook","setup","inciting","rise","midpoint","complication","climax","resolution","cta"],
  "vo_text": string (≤18 words, no line breaks),
  "vo_emphasis": one of ["none","slight","strong"],
  "read_speed_wps": float between 1.8 and 3.2,
  "visual_prompt": {
    "setting": string,
    "characters": string,
    "action": string,
    "props": string,
    "mood": string,
    "lighting": one of ["soft","hard","noir","neon","golden_hour","overcast","practical"],
    "color_palette": one of ["warm","cool","monochrome","teal_orange","pastel"],
    "camera": string,
    "composition": one of ["rule_of_thirds","center","symmetry","leading_lines"],
    "aspect_ratio": "9:16",
    "style_tags": string,
    "negative_tags": "blurry, extra fingers, watermark",
    "model_hint": one of ["sdxl","flux","juggernaut","midjourney","dalle","kling"],
    "seed": int
  },
  "text_overlay": {
    "content": string,
    "position": one of ["top","center","bottom","caption"],
    "weight": one of ["none","subtle","bold"]
  },
  "transition_in": one of ["cut","fade","dolly_in","whip"],
  "transition_out": one of ["cut","fade","dolly_out","whip"],
  "music_cue": one of ["low","medium","high","drop","silence"]
}

RULES:
- Output 30 lines, one JSON object per line, no extra text, no markdown.
- Each scene covers 2000 ms (2 seconds).
- Maintain continuity: reuse seeds within the same beat, change on beat transitions.
- Keep vo_text ≤18 words, natural and concise.
- Use consistent characters wording to avoid identity drift.
- Ensure final scene (#30) has beat="cta" if a call_to_action exists.
- IMPORTANT: Do not wrap output in code blocks or markdown formatting.`;

export async function POST(request: NextRequest) {
  try {
    const { storyBulb, apiKey } = await request.json();

    if (!storyBulb || !apiKey) {
      return NextResponse.json(
        { error: 'Story bulb and API key are required' },
        { status: 400 }
      );
    }

    // Generate storyboard using Google Gemini API
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `${STORYBOARD_PROMPT}\n\nUSER:\nHere is the Story Bulb JSON:\n${JSON.stringify(storyBulb, null, 2)}\n\nExpand this into a 30-scene storyboard in JSONL format.`
            }]
          }],
          generationConfig: {
            temperature: 0.8,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 16384,
            responseMimeType: "text/plain"
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Gemini API Error:', errorText);
      return NextResponse.json(
        { error: `Gemini API error: ${response.status} - ${errorText}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    
    // Extract the generated JSONL from the response
    const generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!generatedText) {
      return NextResponse.json(
        { error: 'No storyboard generated' },
        { status: 500 }
      );
    }

    try {
      // Clean up the response - remove markdown formatting if present
      let cleanedText = generatedText.trim();
      if (cleanedText.startsWith('```json') || cleanedText.startsWith('```')) {
        cleanedText = cleanedText.replace(/^```(json)?\n?/, '').replace(/\n?```$/, '');
      }
      
      // Parse JSONL (each line is a separate JSON object)
      const lines = cleanedText.trim().split('\n').filter(line => line.trim());
      const scenes = [];
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        try {
          const scene = JSON.parse(line);
          scenes.push(scene);
        } catch (e) {
          console.error(`Failed to parse line ${i + 1}:`, line);
          // Continue parsing other lines instead of failing completely
          continue;
        }
      }

      if (scenes.length === 0) {
        throw new Error('No valid scenes parsed from response');
      }
      
      // If we have fewer than 30 scenes, log it but don't fail
      if (scenes.length < 30) {
        console.warn(`Generated ${scenes.length} scenes instead of 30 (may be due to token limit)`);
      }
      
      return NextResponse.json({
        success: true,
        storyboard: scenes,
        storyBulb: storyBulb
      });
    } catch (parseError) {
      console.error('Failed to parse storyboard JSONL:', parseError);
      return NextResponse.json(
        { error: 'Generated storyboard is not valid JSONL', details: parseError instanceof Error ? parseError.message : 'Parse error' },
        { status: 500 }
      );
    }

  } catch (error) {
    console.error('Server error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}