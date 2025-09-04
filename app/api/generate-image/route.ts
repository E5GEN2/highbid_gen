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

    // Use OpenRouter's official image generation format
    const response = await fetch(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://highbidgen.onrender.com',
          'X-Title': 'AI Image Generator'
        },
        body: JSON.stringify({
          model: 'google/gemini-2.5-flash-image-preview',
          messages: [{
            role: 'user',
            content: prompt
          }],
          modalities: ['image', 'text'] // Correct order from docs
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenRouter error:', errorText);
      return NextResponse.json(
        { error: `OpenRouter API error: ${errorText}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    console.log('OpenRouter response structure:', JSON.stringify(data, null, 2));
    
    // Check for images in the assistant message (official format)
    const assistantMessage = data.choices?.[0]?.message;
    
    if (assistantMessage?.images && assistantMessage.images.length > 0) {
      // Images are stored as base64 data URLs
      const imageUrl = assistantMessage.images[0];
      return NextResponse.json({
        image: imageUrl,
        success: true,
        model: 'gemini-2.5-flash-image-preview'
      });
    }

    // Check content array for image parts
    if (assistantMessage?.content && Array.isArray(assistantMessage.content)) {
      for (const part of assistantMessage.content) {
        if (part.type === 'image_url' && part.image_url?.url) {
          return NextResponse.json({
            image: part.image_url.url,
            success: true,
            model: 'gemini-2.5-flash-image-preview'
          });
        }
      }
    }

    // Check for inline image data in various formats
    if (assistantMessage?.content) {
      const content = assistantMessage.content;
      
      if (typeof content === 'string') {
        // Check for data URL in text
        const dataUrlMatch = content.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/);
        if (dataUrlMatch) {
          return NextResponse.json({
            image: dataUrlMatch[0],
            success: true,
            model: 'gemini-2.5-flash-image-preview'
          });
        }
        
        // Model returned text only - not generating images
        return NextResponse.json({
          error: `Model returned text instead of image: "${content.substring(0, 200)}"`,
          success: false,
          debug: 'The model might not have image generation enabled or the prompt needs to be more specific.'
        });
      }
    }

    return NextResponse.json({
      error: 'No image was generated. The response format was unexpected.',
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