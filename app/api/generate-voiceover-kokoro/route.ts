import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const { text, voice = 'af_heart', speed = 1.0, kokoroUrl } = await request.json();

    if (!text || !kokoroUrl) {
      return NextResponse.json(
        { error: 'Text and Kokoro URL are required' },
        { status: 400 }
      );
    }

    // Call Kokoro TTS API using the new /api/generate-voiceover-kokoro endpoint
    const response = await fetch(`${kokoroUrl}/api/generate-voiceover-kokoro`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text,
        voice,
        speed,
        split_pattern: '\\n+',
        sample_rate: 24000
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Kokoro TTS Error:', errorText);
      return NextResponse.json(
        { error: `Kokoro TTS error: ${response.status} - ${errorText}` },
        { status: response.status }
      );
    }

    // The new endpoint returns JSON with base64 audio
    const data = await response.json();
    
    if (!data.audio_base64) {
      return NextResponse.json(
        { error: 'No audio data returned from Kokoro API' },
        { status: 500 }
      );
    }
    
    // Create data URL from the base64 audio
    const audioUrl = `data:audio/wav;base64,${data.audio_base64}`;

    return NextResponse.json({
      success: true,
      audioUrl
    });

  } catch (error) {
    console.error('Server error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// Also support fetching available voices
export async function GET(request: NextRequest) {
  try {
    const kokoroUrl = request.nextUrl.searchParams.get('kokoroUrl');
    
    if (!kokoroUrl) {
      return NextResponse.json(
        { error: 'Kokoro URL is required' },
        { status: 400 }
      );
    }

    const response = await fetch(`${kokoroUrl}/api/voices-kokoro`);
    
    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: `Failed to fetch voices: ${errorText}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    return NextResponse.json(data);

  } catch (error) {
    console.error('Server error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}