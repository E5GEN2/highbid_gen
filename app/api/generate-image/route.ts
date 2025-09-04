import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const { prompt, apiKey } = await request.json();

    if (!prompt || !apiKey) {
      return NextResponse.json(
        { error: 'Prompt and API key are required' },
        { status: 400 }
      );
    }

    // Try Gemini 2.0 Flash Experimental with image generation
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `Generate an image of: ${prompt}`
            }]
          }],
          generationConfig: {
            temperature: 0.4,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 8192,
          }
        })
      }
    );

    if (!response.ok) {
      const errorData = await response.text();
      
      // Try with Imagen 3 through Gemini
      const imagen3Response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/imagen-3.0-generate-001:predict?key=${apiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            instances: [{
              prompt: prompt
            }],
            parameters: {
              sampleCount: 1,
              aspectRatio: "1:1",
              negativePrompt: "blurry, bad quality",
              personGeneration: "allow_adult",
              safetyFilterLevel: "block_some",
              addWatermark: false
            }
          })
        }
      );

      if (!imagen3Response.ok) {
        // Try standard Gemini model to generate image description
        const geminiResponse = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              contents: [{
                parts: [{
                  text: `Create a detailed image generation prompt for: ${prompt}`
                }]
              }]
            })
          }
        );

        if (!geminiResponse.ok) {
          return NextResponse.json(
            { error: `Unable to generate image. Error: ${errorData}` },
            { status: response.status }
          );
        }

        const geminiData = await geminiResponse.json();
        return NextResponse.json({
          error: 'Direct image generation not available. Gemini suggests: ' + geminiData.candidates?.[0]?.content?.parts?.[0]?.text,
          success: false
        });
      }

      const imagen3Data = await imagen3Response.json();
      
      if (imagen3Data.predictions?.[0]?.bytesBase64Encoded) {
        return NextResponse.json({
          image: `data:image/png;base64,${imagen3Data.predictions[0].bytesBase64Encoded}`,
          success: true,
          model: 'imagen-3.0'
        });
      }
    }

    const data = await response.json();
    console.log('Gemini response structure:', JSON.stringify(data, null, 2).substring(0, 500));
    
    // Check if response contains image data
    if (data.candidates?.[0]?.content?.parts?.[0]?.inlineData) {
      const imageData = data.candidates[0].content.parts[0].inlineData;
      return NextResponse.json({
        image: `data:${imageData.mimeType || 'image/png'};base64,${imageData.data}`,
        success: true,
        model: 'gemini-2.0-flash-exp'
      });
    }

    // Check for functionCall with image generation
    if (data.candidates?.[0]?.content?.parts?.[0]?.functionCall) {
      const functionCall = data.candidates[0].content.parts[0].functionCall;
      if (functionCall.name === 'generate_image' && functionCall.args?.image_data) {
        return NextResponse.json({
          image: `data:image/png;base64,${functionCall.args.image_data}`,
          success: true,
          model: 'gemini-2.0-flash-exp'
        });
      }
    }

    // If text response, it might contain base64 or description
    if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
      const textContent = data.candidates[0].content.parts[0].text;
      
      // Check if it's base64 image data
      if (textContent.length > 1000 && (textContent.includes('iVBOR') || textContent.includes('/9j/'))) {
        // Extract base64 from text
        const base64Match = textContent.match(/(?:data:image\/[^;]+;base64,)?([A-Za-z0-9+/=]{100,})/);
        if (base64Match) {
          return NextResponse.json({
            image: `data:image/png;base64,${base64Match[1]}`,
            success: true,
            model: 'gemini-2.0-flash-exp'
          });
        }
      }
      
      return NextResponse.json({
        error: 'This model cannot generate images directly. Response: ' + textContent.substring(0, 200),
        success: false
      });
    }

    return NextResponse.json({
      error: 'The model did not return an image. Try using a different prompt or API key.',
      success: false,
      debug: data
    });

  } catch (error) {
    console.error('Server error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}