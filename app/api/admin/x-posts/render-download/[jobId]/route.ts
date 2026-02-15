import { NextRequest, NextResponse } from 'next/server';
import { getRenderedVideoPath } from '../../../../../../lib/remotion/renderOrchestrator';
import fs from 'fs';

function checkAuth(req: NextRequest): boolean {
  const token = req.cookies.get('admin_token')?.value;
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, 'base64').toString();
    return decoded.startsWith('admin:') && decoded.endsWith(':rofe_admin_secret');
  } catch {
    return false;
  }
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { jobId } = await params;
  const videoPath = getRenderedVideoPath(jobId);

  if (!videoPath) {
    return NextResponse.json({ error: 'Video not found' }, { status: 404 });
  }

  const stat = fs.statSync(videoPath);
  const fileStream = fs.readFileSync(videoPath);

  return new NextResponse(fileStream, {
    headers: {
      'Content-Type': 'video/mp4',
      'Content-Length': stat.size.toString(),
      'Content-Disposition': `attachment; filename="${jobId}.mp4"`,
    },
  });
}
