import { NextResponse } from 'next/server';
import { CLIPS_DIR } from '@/lib/clips-dir';

export async function GET() {
  return NextResponse.json({
    commit: process.env.RAILWAY_GIT_COMMIT_SHA?.substring(0, 7) || 'local',
    branch: process.env.RAILWAY_GIT_BRANCH || 'unknown',
    clipsDir: CLIPS_DIR,
    ts: Date.now(),
  });
}
