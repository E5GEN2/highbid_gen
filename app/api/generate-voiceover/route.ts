import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const { text, apiKey, voiceId = '21m00Tcm4TlvDq8ikWAM', modelId = 'eleven_monolingual_v1' } = await request.json();

    if (!text || !apiKey) {
      return NextResponse.json(
        { error: 'Text and API key are required' },
        { status: 400 }
      );
    }

    // Generate audio using ElevenLabs API
    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: text,
          model_id: modelId,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.5,
            style: 0,
            use_speaker_boost: true
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('ElevenLabs API Error:', errorText);
      return NextResponse.json(
        { error: `ElevenLabs API error: ${response.status} - ${errorText}` },
        { status: response.status }
      );
    }

    // Get audio as buffer
    const audioBuffer = await response.arrayBuffer();
    const base64Audio = Buffer.from(audioBuffer).toString('base64');

    return NextResponse.json({
      audio: `data:audio/mpeg;base64,${base64Audio}`,
      success: true,
      voiceId: voiceId,
      text: text
    });

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
    const apiKey = searchParams.get('apiKey');

    if (!apiKey) {
      return NextResponse.json(
        { error: 'API key is required' },
        { status: 400 }
      );
    }

    // Get available voices from ElevenLabs
    const response = await fetch(
      'https://api.elevenlabs.io/v1/voices',
      {
        method: 'GET',
        headers: {
          'xi-api-key': apiKey,
        }
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('ElevenLabs API Error:', errorText);
      return NextResponse.json(
        { error: `ElevenLabs API error: ${response.status} - ${errorText}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    
    // Simplify voice data for frontend
    const voices = data.voices.map((voice: {
      voice_id: string;
      name: string;
      description: string;
      preview_url: string;
      labels: {
        accent?: string;
        gender?: string;
        age?: string;
        language?: string;
      };
    }) => ({
      voice_id: voice.voice_id,
      name: voice.name,
      description: voice.description,
      preview_url: voice.preview_url,
      labels: voice.labels
    }));

    return NextResponse.json({
      voices: voices,
      success: true
    });

  } catch (error) {
    console.error('Server error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}