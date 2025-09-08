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

    // Call Kokoro TTS API
    const response = await fetch(`${kokoroUrl}/speak`, {
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

    // Get the audio data as ArrayBuffer
    const audioData = await response.arrayBuffer();
    
    // Convert to base64 for frontend consumption
    const base64Audio = Buffer.from(audioData).toString('base64');
    const audioUrl = `data:audio/wav;base64,${base64Audio}`;

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

    const response = await fetch(`${kokoroUrl}/voices`);
    
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