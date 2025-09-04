import { NextRequest, NextResponse } from 'next/server';

function createWavHeader(pcmBuffer: Buffer): Buffer {
  const sampleRate = 24000; // Google TTS returns 24kHz
  const numChannels = 1; // Mono
  const bitsPerSample = 16; // 16-bit PCM
  const byteRate = sampleRate * numChannels * bitsPerSample / 8;
  const blockAlign = numChannels * bitsPerSample / 8;
  const dataSize = pcmBuffer.length;
  const fileSize = 36 + dataSize;
  
  const header = Buffer.alloc(44);
  let offset = 0;
  
  // RIFF header
  header.write('RIFF', offset); offset += 4;
  header.writeUInt32LE(fileSize, offset); offset += 4;
  header.write('WAVE', offset); offset += 4;
  
  // fmt chunk
  header.write('fmt ', offset); offset += 4;
  header.writeUInt32LE(16, offset); offset += 4; // fmt chunk size
  header.writeUInt16LE(1, offset); offset += 2; // PCM format
  header.writeUInt16LE(numChannels, offset); offset += 2;
  header.writeUInt32LE(sampleRate, offset); offset += 4;
  header.writeUInt32LE(byteRate, offset); offset += 4;
  header.writeUInt16LE(blockAlign, offset); offset += 2;
  header.writeUInt16LE(bitsPerSample, offset); offset += 2;
  
  // data chunk
  header.write('data', offset); offset += 4;
  header.writeUInt32LE(dataSize, offset);
  
  return Buffer.concat([header, pcmBuffer]);
}

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
    
    // Create WAV header for the PCM data
    const pcmBuffer = Buffer.from(base64Audio, 'base64');
    const wavBuffer = createWavHeader(pcmBuffer);
    const wavBase64 = wavBuffer.toString('base64');
    
    return NextResponse.json({
      audio: `data:audio/wav;base64,${wavBase64}`,
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
    // Return all 30 available Google Gemini TTS voices
    const voices = [
      { voice_id: 'Kore', name: 'Kore', description: 'Firm, reliable tone', labels: { style: 'Firm', type: 'Professional' } },
      { voice_id: 'Zephyr', name: 'Zephyr', description: 'Bright, energetic tone', labels: { style: 'Bright', type: 'Energetic' } },
      { voice_id: 'Puck', name: 'Puck', description: 'Upbeat, cheerful tone', labels: { style: 'Upbeat', type: 'Cheerful' } },
      { voice_id: 'Charon', name: 'Charon', description: 'Informative, clear tone', labels: { style: 'Informative', type: 'Professional' } },
      { voice_id: 'Fenrir', name: 'Fenrir', description: 'Excitable, dynamic tone', labels: { style: 'Excitable', type: 'Dynamic' } },
      { voice_id: 'Leda', name: 'Leda', description: 'Youthful, vibrant tone', labels: { style: 'Youthful', type: 'Vibrant' } },
      { voice_id: 'Orus', name: 'Orus', description: 'Firm, decisive tone', labels: { style: 'Firm', type: 'Authoritative' } },
      { voice_id: 'Aoede', name: 'Aoede', description: 'Breezy, light tone', labels: { style: 'Breezy', type: 'Light' } },
      { voice_id: 'Callirrhoe', name: 'Callirrhoe', description: 'Easy-going, relaxed tone', labels: { style: 'Easy-going', type: 'Relaxed' } },
      { voice_id: 'Autonoe', name: 'Autonoe', description: 'Bright, optimistic tone', labels: { style: 'Bright', type: 'Optimistic' } },
      { voice_id: 'Enceladus', name: 'Enceladus', description: 'Breathy, gentle tone', labels: { style: 'Breathy', type: 'Gentle' } },
      { voice_id: 'Iapetus', name: 'Iapetus', description: 'Clear, articulate tone', labels: { style: 'Clear', type: 'Articulate' } },
      { voice_id: 'Umbriel', name: 'Umbriel', description: 'Easy-going, calm tone', labels: { style: 'Easy-going', type: 'Calm' } },
      { voice_id: 'Algieba', name: 'Algieba', description: 'Smooth, pleasant tone', labels: { style: 'Smooth', type: 'Pleasant' } },
      { voice_id: 'Despina', name: 'Despina', description: 'Smooth, flowing tone', labels: { style: 'Smooth', type: 'Flowing' } },
      { voice_id: 'Erinome', name: 'Erinome', description: 'Clear, precise tone', labels: { style: 'Clear', type: 'Precise' } },
      { voice_id: 'Algenib', name: 'Algenib', description: 'Gravelly, textured tone', labels: { style: 'Gravelly', type: 'Textured' } },
      { voice_id: 'Rasalgethi', name: 'Rasalgethi', description: 'Informative, professional tone', labels: { style: 'Informative', type: 'Professional' } },
      { voice_id: 'Laomedeia', name: 'Laomedeia', description: 'Upbeat, lively tone', labels: { style: 'Upbeat', type: 'Lively' } },
      { voice_id: 'Achernar', name: 'Achernar', description: 'Soft, gentle tone', labels: { style: 'Soft', type: 'Gentle' } },
      { voice_id: 'Alnilam', name: 'Alnilam', description: 'Firm, strong tone', labels: { style: 'Firm', type: 'Strong' } },
      { voice_id: 'Schedar', name: 'Schedar', description: 'Even, balanced tone', labels: { style: 'Even', type: 'Balanced' } },
      { voice_id: 'Gacrux', name: 'Gacrux', description: 'Mature, experienced tone', labels: { style: 'Mature', type: 'Experienced' } },
      { voice_id: 'Pulcherrima', name: 'Pulcherrima', description: 'Forward, expressive tone', labels: { style: 'Forward', type: 'Expressive' } },
      { voice_id: 'Achird', name: 'Achird', description: 'Friendly, approachable tone', labels: { style: 'Friendly', type: 'Approachable' } },
      { voice_id: 'Zubenelgenubi', name: 'Zubenelgenubi', description: 'Casual, relaxed tone', labels: { style: 'Casual', type: 'Relaxed' } },
      { voice_id: 'Vindemiatrix', name: 'Vindemiatrix', description: 'Gentle, kind tone', labels: { style: 'Gentle', type: 'Kind' } },
      { voice_id: 'Sadachbia', name: 'Sadachbia', description: 'Lively, animated tone', labels: { style: 'Lively', type: 'Animated' } },
      { voice_id: 'Sadaltager', name: 'Sadaltager', description: 'Knowledgeable, authoritative tone', labels: { style: 'Knowledgeable', type: 'Authoritative' } },
      { voice_id: 'Sulafat', name: 'Sulafat', description: 'Warm, welcoming tone', labels: { style: 'Warm', type: 'Welcoming' } }
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