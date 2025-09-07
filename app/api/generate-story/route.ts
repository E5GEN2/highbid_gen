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
  "action_emphasis": string (guidance for creating action-packed scenes),
  "domino_sequences": array of 3-5 cause-effect chains (e.g., ["hero's attack → enemy escalates → ally betrays", "discovery → pursuit → trap"]),
  "setups_payoffs": array of setup/payoff pairs (e.g., [{"setup": "hidden weapon", "payoff": "saves hero in climax"}]),
  "escalation_points": array of 3 moments where stakes increase BECAUSE of protagonist actions,
  "plot_threads": object with three acts and their key turning points {
    "act1": {"turning_point": string, "consequence": string},
    "act2": {"turning_point": string, "consequence": string},
    "act3": {"turning_point": string, "consequence": string}
  }
}

RULES:
- All values must be single-line strings (no line breaks).
- runtime_sec is always 60 unless explicitly told otherwise.
- Keep premise and twist short, max 22 words.
- CRITICAL: Create CAUSALLY-LINKED narratives where each action triggers consequences.
- Every story beat must connect: "because X happened, Y must occur, but then Z interrupts"
- domino_sequences must show clear cause-effect chains, not random events
- setups_payoffs must plant elements early that become crucial later
- escalation_points must be CAUSED BY the protagonist's choices, not random events
- plot_threads must show how each act's climax directly causes the next act's conflict
- Use "therefore/but/however" logic, never "and then/also/next"
- action_emphasis should specify HOW actions cause reactions and consequences
- Do not output anything except the JSON object.`;

export async function POST(request: NextRequest) {
  try {
    const { title, apiKey, model = 'gemini-2.0-flash-exp' } = await request.json();

    if (!title || !apiKey) {
      return NextResponse.json(
        { error: 'Title and API key are required' },
        { status: 400 }
      );
    }

    // Generate story using Google Gemini API
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
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
            maxOutputTokens: 2048,
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
    
    // Extract the generated JSON from the response
    const generatedText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (!generatedText) {
      return NextResponse.json(
        { error: 'No story generated' },
        { status: 500 }
      );
    }

    try {
      // Clean the response - remove markdown code blocks if present
      let cleanedText = generatedText.trim();
      
      // Remove markdown code block wrapper if present
      if (cleanedText.startsWith('```json') || cleanedText.startsWith('```')) {
        cleanedText = cleanedText.replace(/^```(json)?\n?/, '').replace(/\n?```$/, '');
      }
      
      // Parse the JSON to validate it
      const storyBulb = JSON.parse(cleanedText);
      
      // Ensure all required fields have default values if missing
      // Handle plot_threads which might be missing consequence fields
      const plot_threads = storyBulb.plot_threads || {};
      const completeStoryBulb = {
        ...storyBulb,
        domino_sequences: storyBulb.domino_sequences || [],
        setups_payoffs: storyBulb.setups_payoffs || [],
        escalation_points: storyBulb.escalation_points || [],
        plot_threads: {
          act1: { 
            turning_point: plot_threads.act1?.turning_point || plot_threads.act_1?.turning_point || "", 
            consequence: plot_threads.act1?.consequence || plot_threads.act_1?.consequence || ""
          },
          act2: { 
            turning_point: plot_threads.act2?.turning_point || plot_threads.act_2?.turning_point || "", 
            consequence: plot_threads.act2?.consequence || plot_threads.act_2?.consequence || ""
          },
          act3: { 
            turning_point: plot_threads.act3?.turning_point || plot_threads.act_3?.turning_point || "", 
            consequence: plot_threads.act3?.consequence || plot_threads.act_3?.consequence || ""
          }
        }
      };
      
      return NextResponse.json({
        success: true,
        storyBulb: completeStoryBulb
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