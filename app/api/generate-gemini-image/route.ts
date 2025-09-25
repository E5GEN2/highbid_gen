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

    // Note: Gemini image generation requires billing enabled
    // Using gemini-2.5-flash-image-preview (aka "nano banana") - the latest model
    // Free tier will get quota exceeded error
    const model = 'gemini-2.5-flash-image-preview';
    
    // Create the request to generate an image using Gemini's native image generation
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
              text: `Generate an image of: ${prompt}\n\nIMPORTANT: Generate a high-quality, detailed image based on this description.`
            }]
          }],
          generationConfig: {
            temperature: 0.4,
            topK: 32,
            topP: 1,
            maxOutputTokens: 8192,
            responseMimeType: "application/json",
            responseSchema: {
              type: "object",
              properties: {
                image: {
                  type: "string",
                  description: "Base64 encoded image data"
                }
              }
            }
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Gemini API Error:', errorText);
      
      // Check for quota/billing issues
      if (errorText.includes('quota') || errorText.includes('billing') || response.status === 429) {
        return NextResponse.json(
          { 
            error: 'Gemini image generation requires a paid API plan with billing enabled.',
            details: 'The gemini-2.5-flash-image-preview model is not available in the free tier. Please enable billing in your Google AI Studio account or use OpenRouter/Highbid for image generation.',
            requiresBilling: true
          },
          { status: 402 } // Payment Required
        );
      }
      
      // Check if this is because the model doesn't support image generation
      if (errorText.includes('does not support') || errorText.includes('image generation')) {
        // Try using the model to generate an image URL through creative prompting
        const fallbackResponse = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
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
                temperature: 0.8,
                topK: 40,
                topP: 0.95,
                maxOutputTokens: 2048
              }
            })
          }
        );

        if (!fallbackResponse.ok) {
          return NextResponse.json(
            { error: 'Gemini 2.0 Flash does not currently support direct image generation in free tier. Please use OpenRouter or Highbid for image generation.' },
            { status: 400 }
          );
        }

        const fallbackData = await fallbackResponse.json();
        const generatedText = fallbackData.candidates?.[0]?.content?.parts?.[0]?.text || '';
        
        // Return a placeholder or instruction
        return NextResponse.json({
          error: 'Direct image generation not available in free tier. Consider using the paid gemini-2.0-flash-preview-image-generation model or switch to OpenRouter/Highbid.',
          suggestion: generatedText,
          requiresPaid: true
        }, { status: 400 });
      }
      
      return NextResponse.json(
        { error: `Gemini API error: ${response.status} - ${errorText}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    console.log('Gemini response structure:', JSON.stringify(data, null, 2).substring(0, 500));
    
    // Check different possible response formats
    let imageData = null;
    
    // Check if response contains base64 image directly
    if (data.candidates?.[0]?.content?.parts?.[0]?.inlineData) {
      const inlineData = data.candidates[0].content.parts[0].inlineData;
      imageData = `data:${inlineData.mimeType || 'image/png'};base64,${inlineData.data}`;
    } 
    // Check if response contains image in text format
    else if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
      const text = data.candidates[0].content.parts[0].text;
      // Check if the text contains base64 image data
      if (text.includes('data:image')) {
        imageData = text;
      } else {
        try {
          // Try parsing as JSON in case it returns structured data
          const parsed = JSON.parse(text);
          if (parsed.image) {
            imageData = parsed.image.startsWith('data:') ? parsed.image : `data:image/png;base64,${parsed.image}`;
          }
        } catch {
          // Not JSON, might be a description or error
          console.log('Gemini returned text instead of image:', text.substring(0, 200));
        }
      }
    }
    // Check if the response has the image in the expected schema format
    else if (data.image) {
      imageData = data.image.startsWith('data:') ? data.image : `data:image/png;base64,${data.image}`;
    }

    if (!imageData) {
      console.error('No image data found in Gemini response');
      return NextResponse.json(
        { 
          error: 'Gemini 2.0 Flash free tier does not support image generation. Please use gemini-2.0-flash-preview-image-generation (requires billing) or switch to OpenRouter/Highbid.',
          details: 'Image generation requires a paid Gemini API plan.'
        },
        { status: 400 }
      );
    }

    return NextResponse.json({
      image: imageData,
      success: true,
      prompt: prompt
    });

  } catch (error) {
    console.error('Server error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}