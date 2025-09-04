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

    // Use the verified working model from OpenRouter
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
          model: 'google/gemini-2.5-flash-image-preview:free',
          messages: [{
            role: 'user',
            content: [{
              type: 'text',
              text: prompt
            }]
          }],
          temperature: 0.7,
          max_tokens: 4096
        })
      }
    );

    if (!response.ok) {
      const errorData = await response.text();
      console.error('OpenRouter API Error:', errorData);
      return NextResponse.json(
        { error: `OpenRouter API error: ${errorData}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    console.log('OpenRouter response:', JSON.stringify(data, null, 2).substring(0, 500));
    
    // Check if response contains image data
    if (data.choices?.[0]?.message?.content) {
      const content = data.choices[0].message.content;
      
      // Handle different response formats
      if (Array.isArray(content)) {
        // Content is an array of parts
        for (const part of content) {
          if (part.type === 'image_url' && part.image_url?.url) {
            return NextResponse.json({
              image: part.image_url.url,
              success: true,
              model: 'gemini-2.5-flash-image-preview'
            });
          }
          
          if (part.type === 'inline_data' && part.inline_data?.data) {
            return NextResponse.json({
              image: `data:${part.inline_data.mime_type || 'image/png'};base64,${part.inline_data.data}`,
              success: true,
              model: 'gemini-2.5-flash-image-preview'
            });
          }
        }
      } else if (typeof content === 'string') {
        // Content is a string - check for base64 or URLs
        
        // Check for data URL format
        const dataUrlMatch = content.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/);
        if (dataUrlMatch) {
          return NextResponse.json({
            image: dataUrlMatch[0],
            success: true,
            model: 'gemini-2.5-flash-image-preview'
          });
        }
        
        // Check for raw base64 (if it's a long string of base64 characters)
        if (content.length > 1000 && /^[A-Za-z0-9+/=]{100,}$/.test(content.trim())) {
          return NextResponse.json({
            image: `data:image/png;base64,${content.trim()}`,
            success: true,
            model: 'gemini-2.5-flash-image-preview'
          });
        }
        
        // Check for HTTP URLs
        const urlMatch = content.match(/https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp)/i);
        if (urlMatch) {
          return NextResponse.json({
            image: urlMatch[0],
            success: true,
            model: 'gemini-2.5-flash-image-preview'
          });
        }
        
        // If it's just text describing an image or error
        return NextResponse.json({
          error: `Model response: ${content.substring(0, 200)}`,
          success: false
        });
      }
    }

    // Check for inline_data at message level
    if (data.choices?.[0]?.message?.inline_data) {
      const inlineData = data.choices[0].message.inline_data;
      return NextResponse.json({
        image: `data:${inlineData.mime_type || 'image/png'};base64,${inlineData.data}`,
        success: true,
        model: 'gemini-2.5-flash-image-preview'
      });
    }

    return NextResponse.json({
      error: 'No image data found in response',
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