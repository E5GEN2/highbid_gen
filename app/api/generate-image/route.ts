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

    // Use OpenRouter API with image generation models
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
          model: 'google/gemini-2.0-flash-exp:free', // Free tier model
          messages: [{
            role: 'user',
            content: [
              {
                type: 'text',
                text: `Generate an image: ${prompt}`
              }
            ]
          }],
          temperature: 0.7,
          max_tokens: 4096,
          provider: {
            allow_fallbacks: true
          }
        })
      }
    );

    if (!response.ok) {
      const errorData = await response.text();
      console.error('OpenRouter API Error:', errorData);
      
      // Try with a different model
      const fallbackResponse = await fetch(
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
            model: 'google/gemini-flash-1.5-exp', // Alternative model
            messages: [{
              role: 'user',
              content: `Create an image of: ${prompt}`
            }],
            temperature: 0.7,
            max_tokens: 4096
          })
        }
      );

      if (!fallbackResponse.ok) {
        return NextResponse.json(
          { error: `OpenRouter API error: ${errorData}` },
          { status: response.status }
        );
      }

      const fallbackData = await fallbackResponse.json();
      console.log('Fallback response:', JSON.stringify(fallbackData, null, 2).substring(0, 500));
      
      // Check if response contains image
      if (fallbackData.choices?.[0]?.message?.content) {
        const content = fallbackData.choices[0].message.content;
        
        // Check if content is base64 image
        if (content.includes('base64,') || content.includes('data:image')) {
          const base64Match = content.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/);
          if (base64Match) {
            return NextResponse.json({
              image: base64Match[0],
              success: true,
              model: 'gemini-flash-1.5-exp via OpenRouter'
            });
          }
        }
        
        // If it's just text, return as error
        return NextResponse.json({
          error: 'Model returned text instead of image: ' + content.substring(0, 200),
          success: false
        });
      }
    }

    const data = await response.json();
    console.log('OpenRouter response:', JSON.stringify(data, null, 2).substring(0, 500));
    
    // Check OpenRouter response format
    if (data.choices?.[0]?.message?.content) {
      const content = data.choices[0].message.content;
      
      // Check if content contains image data
      if (typeof content === 'string') {
        // Check for base64 image in response
        if (content.includes('base64,') || content.includes('data:image')) {
          const base64Match = content.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/);
          if (base64Match) {
            return NextResponse.json({
              image: base64Match[0],
              success: true,
              model: 'gemini-2.0-flash via OpenRouter'
            });
          }
        }
        
        // Check if raw base64
        if (content.length > 1000 && /^[A-Za-z0-9+/=]{100,}$/.test(content.trim())) {
          return NextResponse.json({
            image: `data:image/png;base64,${content.trim()}`,
            success: true,
            model: 'gemini-2.0-flash via OpenRouter'
          });
        }
      }
      
      // If content is array with image
      if (Array.isArray(content)) {
        for (const item of content) {
          if (item.type === 'image_url' && item.image_url?.url) {
            return NextResponse.json({
              image: item.image_url.url,
              success: true,
              model: 'gemini-2.0-flash via OpenRouter'
            });
          }
        }
      }
      
      return NextResponse.json({
        error: 'Model did not generate an image. Response: ' + (typeof content === 'string' ? content.substring(0, 200) : JSON.stringify(content).substring(0, 200)),
        success: false
      });
    }

    // Check for other possible image fields
    if (data.data?.[0]?.url) {
      return NextResponse.json({
        image: data.data[0].url,
        success: true,
        model: 'via OpenRouter'
      });
    }

    if (data.data?.[0]?.b64_json) {
      return NextResponse.json({
        image: `data:image/png;base64,${data.data[0].b64_json}`,
        success: true,
        model: 'via OpenRouter'
      });
    }

    return NextResponse.json({
      error: 'Unexpected response format from OpenRouter API',
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