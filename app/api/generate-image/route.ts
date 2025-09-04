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

    // Use OpenRouter's image generation endpoint with modalities
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
            content: prompt
          }],
          modalities: ['text', 'image'], // This enables image generation
          temperature: 0.7,
          max_tokens: 4096
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('OpenRouter error:', errorText);
      
      // Try with different free models if the first fails
      const fallbackModels = [
        'black-forest-labs/flux-schnell:free',
        'stabilityai/stable-diffusion-xl-base-1.0:free'
      ];

      for (const model of fallbackModels) {
        try {
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
                model: model,
                messages: [{
                  role: 'user',
                  content: prompt
                }],
                modalities: ['text', 'image'],
                temperature: 0.7,
                max_tokens: 4096
              })
            }
          );

          if (fallbackResponse.ok) {
            const fallbackData = await fallbackResponse.json();
            console.log(`Success with fallback model ${model}:`, JSON.stringify(fallbackData, null, 2).substring(0, 300));
            
            // Process fallback response
            if (fallbackData.choices?.[0]?.message?.content) {
              const content = fallbackData.choices[0].message.content;
              
              // Check for image data in various formats
              if (Array.isArray(content)) {
                for (const part of content) {
                  if (part.type === 'image_url' && part.image_url?.url) {
                    return NextResponse.json({
                      image: part.image_url.url,
                      success: true,
                      model: model
                    });
                  }
                  if (part.type === 'image' && part.source?.data) {
                    return NextResponse.json({
                      image: `data:${part.source.media_type || 'image/png'};base64,${part.source.data}`,
                      success: true,
                      model: model
                    });
                  }
                }
              }
            }
          }
        } catch (error) {
          console.log(`Fallback model ${model} failed:`, error);
          continue;
        }
      }

      return NextResponse.json(
        { error: `OpenRouter API error: ${errorText}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    console.log('OpenRouter response structure:', JSON.stringify(data, null, 2).substring(0, 1000));
    
    // Check for image content in the response
    if (data.choices?.[0]?.message?.content) {
      const content = data.choices[0].message.content;
      
      // Handle array content (multimodal response)
      if (Array.isArray(content)) {
        for (const part of content) {
          // OpenRouter image format
          if (part.type === 'image_url' && part.image_url?.url) {
            return NextResponse.json({
              image: part.image_url.url,
              success: true,
              model: 'gemini-2.5-flash-image-preview'
            });
          }
          
          // Gemini inline data format
          if (part.type === 'image' && part.source?.data) {
            return NextResponse.json({
              image: `data:${part.source.media_type || 'image/png'};base64,${part.source.data}`,
              success: true,
              model: 'gemini-2.5-flash-image-preview'
            });
          }

          // Alternative inline data format
          if (part.inline_data?.data) {
            return NextResponse.json({
              image: `data:${part.inline_data.mime_type || 'image/png'};base64,${part.inline_data.data}`,
              success: true,
              model: 'gemini-2.5-flash-image-preview'
            });
          }
        }
      }
      
      // Handle string content
      if (typeof content === 'string') {
        // Check for data URL
        const dataUrlMatch = content.match(/data:image\/[^;]+;base64,([A-Za-z0-9+/=]+)/);
        if (dataUrlMatch) {
          return NextResponse.json({
            image: dataUrlMatch[0],
            success: true,
            model: 'gemini-2.5-flash-image-preview'
          });
        }
        
        // Check for URLs
        const urlMatch = content.match(/https?:\/\/[^\s]+\.(jpg|jpeg|png|gif|webp)/i);
        if (urlMatch) {
          return NextResponse.json({
            image: urlMatch[0],
            success: true,
            model: 'gemini-2.5-flash-image-preview'
          });
        }
        
        // If it's text, the model is not generating images
        return NextResponse.json({
          error: `The model is responding with text instead of generating an image. Response: "${content.substring(0, 200)}"`,
          success: false,
          suggestion: 'Try using a different prompt or the model might not have image generation enabled.'
        });
      }
    }

    // Check for image data at the message level
    if (data.choices?.[0]?.message?.image_url) {
      return NextResponse.json({
        image: data.choices[0].message.image_url.url,
        success: true,
        model: 'gemini-2.5-flash-image-preview'
      });
    }

    return NextResponse.json({
      error: 'No image was generated. The model might not support image generation or returned an unexpected format.',
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