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

    // Try Gemini 2.5 Flash Image (latest model with image generation)
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image-preview:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: prompt
            }]
          }],
          generationConfig: {
            temperature: 0.4,
            topK: 32,
            topP: 1,
            maxOutputTokens: 4096,
            responseMimeType: "image/png"
          }
        })
      }
    );

    if (!response.ok) {
      const errorData = await response.text();
      
      // Fallback to Gemini 2.0 Flash with image generation
      const fallbackResponse = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            contents: [{
              parts: [{
                text: prompt
              }]
            }],
            generationConfig: {
              temperature: 0.4,
              topK: 32,
              topP: 1,
              maxOutputTokens: 8192,
              responseMimeType: "image/png"
            }
          })
        }
      );

      if (!fallbackResponse.ok) {
        const fallbackError = await fallbackResponse.text();
        console.error('Google API Error:', errorData, fallbackError);
        return NextResponse.json(
          { error: `Unable to generate image. Make sure your API key has access to image generation models. Error: ${errorData}` },
          { status: response.status }
        );
      }

      const fallbackData = await fallbackResponse.json();
      
      if (fallbackData.candidates?.[0]?.content?.parts?.[0]?.inlineData) {
        const imageData = fallbackData.candidates[0].content.parts[0].inlineData;
        return NextResponse.json({
          image: `data:${imageData.mimeType || 'image/png'};base64,${imageData.data}`,
          success: true,
          model: 'gemini-2.0-flash-exp'
        });
      }

      // Check for base64 text response (some models return base64 as text)
      if (fallbackData.candidates?.[0]?.content?.parts?.[0]?.text) {
        const textContent = fallbackData.candidates[0].content.parts[0].text;
        // Check if it's base64 image data
        if (textContent.startsWith('iVBOR') || textContent.startsWith('/9j/')) {
          return NextResponse.json({
            image: `data:image/png;base64,${textContent}`,
            success: true,
            model: 'gemini-2.0-flash-exp'
          });
        }
      }
    }

    const data = await response.json();
    
    // Check if response contains image data as inlineData
    if (data.candidates?.[0]?.content?.parts?.[0]?.inlineData) {
      const imageData = data.candidates[0].content.parts[0].inlineData;
      return NextResponse.json({
        image: `data:${imageData.mimeType || 'image/png'};base64,${imageData.data}`,
        success: true,
        model: 'gemini-2.5-flash-image-preview'
      });
    }

    // Check for base64 text response (some models return base64 as text)
    if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
      const textContent = data.candidates[0].content.parts[0].text;
      // Check if it's base64 image data
      if (textContent.startsWith('iVBOR') || textContent.startsWith('/9j/')) {
        return NextResponse.json({
          image: `data:image/png;base64,${textContent}`,
          success: true,
          model: 'gemini-2.5-flash-image-preview'
        });
      }
      
      // If it's actual text, return error
      return NextResponse.json({
        error: 'Model returned text instead of image. Response: ' + textContent.substring(0, 200),
        success: false
      });
    }

    return NextResponse.json({
      error: 'Unexpected response format from API. The model might not support image generation.',
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