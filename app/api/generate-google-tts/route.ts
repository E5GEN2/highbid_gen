import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
  try {
    const { text, apiKey, voiceName = 'Kore' } = await request.json();

    if (!text || !apiKey) {
      return NextResponse.json(
        { error: 'Text and API key are required' },
        { status: 400 }
      );
    }

    // Generate audio using Google Gemini TTS API
    const response = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent',
      {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ 
            parts: [{ text: text }] 
          }],
          generationConfig: {
            responseModalities: ["AUDIO"],
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: { 
                  voiceName: voiceName 
                }
              }
            }
          }
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Google Gemini TTS API Error:', errorText);
      return NextResponse.json(
        { error: `Google Gemini TTS API error: ${response.status} - ${errorText}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    
    // Extract audio data from response
    const audioData = data.candidates?.[0]?.content?.parts?.find((part: { inlineData?: { mimeType?: string; data?: string } }) => part.inlineData?.mimeType?.startsWith('audio/'));
    
    if (!audioData?.inlineData?.data) {
      console.error('No audio data in response:', JSON.stringify(data, null, 2));
      return NextResponse.json(
        { error: 'No audio data received from Google Gemini TTS API' },
        { status: 500 }
      );
    }

    // Convert PCM to WAV format
    const base64Audio = audioData.inlineData.data;
    const audioMimeType = audioData.inlineData.mimeType;
    
    return NextResponse.json({
      audio: `data:${audioMimeType};base64,${base64Audio}`,
      success: true,
      voiceName: voiceName,
      text: text,
      provider: 'google-gemini'
    });

  } catch (error) {
    console.error('Server error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function GET(_request: NextRequest) {
  try {
    // Return available Google Gemini TTS voices
    const voices = [
      { voice_id: 'Kore', name: 'Kore', description: 'Conversational, clear', labels: { gender: 'Female', style: 'Natural' } },
      { voice_id: 'Zephyr', name: 'Zephyr', description: 'Bright, energetic', labels: { gender: 'Male', style: 'Bright' } },
      { voice_id: 'Puck', name: 'Puck', description: 'Upbeat, cheerful', labels: { gender: 'Male', style: 'Upbeat' } },
      { voice_id: 'Charon', name: 'Charon', description: 'Informative, authoritative', labels: { gender: 'Male', style: 'Informative' } },
      { voice_id: 'Cosmic', name: 'Cosmic', description: 'Mysterious, ethereal', labels: { gender: 'Neutral', style: 'Ethereal' } },
      { voice_id: 'Sage', name: 'Sage', description: 'Wise, calm', labels: { gender: 'Male', style: 'Calm' } },
      { voice_id: 'Fenix', name: 'Fenix', description: 'Dynamic, powerful', labels: { gender: 'Female', style: 'Dynamic' } },
      { voice_id: 'Vox', name: 'Vox', description: 'Professional, clear', labels: { gender: 'Male', style: 'Professional' } },
      { voice_id: 'Nova', name: 'Nova', description: 'Bright, youthful', labels: { gender: 'Female', style: 'Youthful' } },
      { voice_id: 'Echo', name: 'Echo', description: 'Resonant, deep', labels: { gender: 'Male', style: 'Deep' } }
    ];

    return NextResponse.json({
      voices: voices,
      success: true,
      provider: 'google-gemini'
    });

  } catch (error) {
    console.error('Server error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}