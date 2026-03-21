import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import fs from 'fs';
import path from 'path';

const CLIPS_DIR = '/tmp/clips';

/**
 * POST /api/clipping/upload
 * Upload a video file for clipping. Stores to /tmp/clips/{projectId}/source.{ext}
 * Body: multipart form data with "file" and "projectId" fields.
 * Returns: { url: string, size: number, duration?: number }
 */
export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const formData = await req.formData();
  const file = formData.get('file') as File | null;
  const projectId = formData.get('projectId') as string | null;

  if (!file) {
    return NextResponse.json({ error: 'No file provided' }, { status: 400 });
  }
  if (!projectId) {
    return NextResponse.json({ error: 'projectId required' }, { status: 400 });
  }

  // Determine extension from file name or type
  const origName = file.name || 'video.mp4';
  const ext = path.extname(origName) || '.mp4';

  // Ensure directory exists
  const dir = path.join(CLIPS_DIR, projectId);
  fs.mkdirSync(dir, { recursive: true });

  const filePath = path.join(dir, `source${ext}`);

  // Write file to disk
  const buffer = Buffer.from(await file.arrayBuffer());
  fs.writeFileSync(filePath, buffer);

  return NextResponse.json({
    url: `file://${filePath}`,
    path: filePath,
    size: buffer.length,
    filename: origName,
  });
}

// Allow large video uploads (up to 500MB)
export const maxDuration = 300; // 5 min timeout for large uploads
