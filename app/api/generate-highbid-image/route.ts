import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const { prompt, apiUrl, width = 1024, height = 1024 } = await request.json();

    if (!prompt || !apiUrl) {
      return NextResponse.json(
        { error: 'Prompt and API URL are required' },
        { status: 400 }
      );
    }

    // First check API health
    try {
      const healthResponse = await fetch(`${apiUrl}/health`, {
        method: 'GET',
        headers: {
          'ngrok-skip-browser-warning': 'true'
        }
      });
      
      if (healthResponse.ok) {
        const healthData = await healthResponse.json();
        console.log('Highbid API Health:', healthData);
        if (!healthData.model_loaded) {
          console.log('Model still loading, attempting generation anyway...');
        }
      }
    } catch (healthError) {
      console.log('Health check failed, attempting generation anyway:', healthError);
    }

    // Generate image using Highbid API
    const response = await fetch(
      `${apiUrl}/generate`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'ngrok-skip-browser-warning': 'true'
        },
        body: JSON.stringify({
          prompt: prompt,
          width: width,
          height: height,
          steps: 4
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Highbid API Error:', errorText);
      return NextResponse.json(
        { error: `Highbid API error: ${response.status} - ${errorText}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    
    if (data.success && data.image) {
      // Return the base64 image with data URL prefix
      return NextResponse.json({
        image: `data:image/png;base64,${data.image}`,
        success: true,
        model: 'highbid-flux',
        dimensions: `${width}x${height}`
      });
    } else {
      return NextResponse.json(
        { error: data.error || 'Failed to generate image' },
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

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const apiUrl = searchParams.get('apiUrl');

    if (!apiUrl) {
      return NextResponse.json(
        { error: 'API URL is required' },
        { status: 400 }
      );
    }

    // Check Highbid API health
    const response = await fetch(
      `${apiUrl}/health`,
      {
        method: 'GET',
        headers: {
          'ngrok-skip-browser-warning': 'true'
        }
      }
    );

    if (!response.ok) {
      return NextResponse.json(
        { error: `Highbid API unreachable: ${response.status}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    
    return NextResponse.json({
      ...data,
      success: true
    });

  } catch (error) {
    console.error('Server error:', error);
    return NextResponse.json(
      { error: 'Failed to check API health', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}