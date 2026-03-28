import { NextRequest, NextResponse } from 'next/server';
import { getApiUser } from '@/lib/api-auth';
import { CLIPS_DIR } from '@/lib/clips-dir';
import fs from 'fs';
import path from 'path';

/**
 * POST /api/clipping/upload
 * Upload a video file for clipping. Stores to /tmp/clips/{projectId}/source.{ext}
 * Body: multipart form data with "file" and "projectId" fields.
 * Returns: { url: string, path: string, size: number, filename: string }
 */
export async function POST(req: NextRequest) {
  const user = await getApiUser(req);
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
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

    // Stream file to disk in chunks to avoid OOM on large files
    const writeStream = fs.createWriteStream(filePath);
    const reader = file.stream().getReader();
    let totalWritten = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      writeStream.write(value);
      totalWritten += value.length;
    }

    await new Promise<void>((resolve, reject) => {
      writeStream.end(() => resolve());
      writeStream.on('error', reject);
    });

    return NextResponse.json({
      url: `file://${filePath}`,
      path: filePath,
      size: totalWritten,
      filename: origName,
    });
  } catch (err) {
    console.error('Upload error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Upload failed' },
      { status: 500 }
    );
  }
}

// Allow large video uploads and long processing time
export const maxDuration = 300;
