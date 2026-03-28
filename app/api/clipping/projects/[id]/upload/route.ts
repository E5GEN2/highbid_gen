import { NextRequest, NextResponse } from 'next/server';
import { CLIPS_DIR } from '@/lib/clips-dir';
import { validateProject, setStepDone, logStep } from '@/lib/clipping-pipeline';
import fs from 'fs';
import path from 'path';

/**
 * POST /api/clipping/projects/{id}/upload
 * Upload a local video file. Synchronous — returns after file is written.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const validation = await validateProject(req, projectId);
  if (validation instanceof NextResponse) return validation;

  const formData = await req.formData();
  const file = formData.get('file') as File | null;
  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });

  const origName = file.name || 'video.mp4';
  const ext = path.extname(origName) || '.mp4';
  const dir = path.join(CLIPS_DIR, projectId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `source${ext}`);

  // Stream to disk
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

  await setStepDone(projectId, { source_path: filePath, source_url: origName });
  await logStep(projectId, 'upload', 'done', `Uploaded ${origName} (${(totalWritten / 1e6).toFixed(1)}MB)`);

  return NextResponse.json({ ok: true, step: 'upload', path: filePath, size: totalWritten, filename: origName });
}

export const maxDuration = 300;
