import { NextRequest, NextResponse } from 'next/server';
import { getJob } from '../../../../../../lib/videoQueue';

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
  const job = await getJob(jobId);

  if (!job) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 });
  }

  return NextResponse.json({
    status: job.status,
    progress: job.progress,
    videoUrl: job.videoUrl || null,
    error: job.error || null,
  });
}
