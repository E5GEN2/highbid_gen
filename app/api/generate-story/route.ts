import { NextRequest, NextResponse } from 'next/server';

const STORY_BULB_PROMPT = `SYSTEM:
You are a story generator. 
You must output valid JSON only, with no explanations, no prose, no comments.

The JSON object must have the following keys:
{
  "title": string,
  "runtime_sec": 60,
  "tone": one of ["inspiring","dramatic","cozy","creepy","comedic","educational"],
  "narration_pov": one of ["first_person","third_person"],
  "target_viewer": string,
  "premise": string (≤22 words),
  "protagonist": string,
  "goal": string,
  "stakes": string,
  "setting": string,
  "constraint": string,
  "twist": string (≤22 words),
  "call_to_action": string or "",
  "visual_style": string (free-form description),
  "action_emphasis": string (guidance for creating action-packed scenes)
}

RULES:
- All values must be single-line strings (no line breaks).
- runtime_sec is always 60 unless explicitly told otherwise.
- Keep premise and twist short, max 22 words.
- CRITICAL: Focus on ACTION-DRIVEN narratives. Avoid passive observation.
- Every story element should lead to dynamic, visual scenes with conflict/movement.
- action_emphasis should guide how each scene will show action, not passive states.
- Examples of good action_emphasis: "constant movement and revelations", "each scene shows character making discoveries", "fast-paced confrontations and escapes".
- Do not output anything except the JSON object.`;

export async function POST(request: NextRequest) {
  try {
    const { title, apiKey } = await request.json();

    if (!title || !apiKey) {
      return NextResponse.json(
        { error: 'Title and API key are required' },
        { status: 400 }
      );
    }

    // Generate story using Google Gemini API
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
              text: `${STORY_BULB_PROMPT}\n\nUSER:\nGenerate a Story Bulb JSON for this viral title: "${title}"`
            }]
          }],
          generationConfig: {
            temperature: 0.9,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 1024,
            responseMimeType: "application/json"
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
    
    // Extract the generated JSON from the response
    const generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!generatedText) {
      return NextResponse.json(
        { error: 'No story generated' },
        { status: 500 }
      );
    }

    try {
      // Parse the JSON to validate it
      const storyBulb = JSON.parse(generatedText);
      
      return NextResponse.json({
        success: true,
        storyBulb: storyBulb
      });
    } catch (parseError) {
      console.error('Failed to parse story JSON:', generatedText, parseError);
      return NextResponse.json(
        { error: 'Generated story is not valid JSON', raw: generatedText },
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