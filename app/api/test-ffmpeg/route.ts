import { NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export async function GET() {
  try {
    const { stdout } = await execAsync('ffmpeg -version');
    return NextResponse.json({
      success: true,
      ffmpeg: 'available',
      version: stdout.split('\n')[0]
    });
  } catch (error) {
    return NextResponse.json({
      success: false,
      ffmpeg: 'not available',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}