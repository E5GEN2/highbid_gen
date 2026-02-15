import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';

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

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const videoIds = req.nextUrl.searchParams.get('ids')?.split(',').filter(Boolean);
  if (!videoIds || videoIds.length === 0) {
    return NextResponse.json({ error: 'ids parameter required' }, { status: 400 });
  }

  const ids = videoIds.slice(0, 3);
  const GAP = 8;

  try {
    // Fetch thumbnails in parallel
    const buffers = await Promise.all(
      ids.map(async (id) => {
        const url = `https://img.youtube.com/vi/${id}/hqdefault.jpg`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Failed to fetch thumbnail for ${id}`);
        return Buffer.from(await res.arrayBuffer());
      })
    );

    // Get dimensions of first image to determine sizing
    const meta = await sharp(buffers[0]).metadata();
    const thumbW = meta.width || 480;
    const thumbH = meta.height || 360;

    // Resize each thumb to consistent height, crop to 9:16 aspect (vertical Shorts)
    const cropW = Math.round(thumbH * (9 / 16));
    const resizedBuffers = await Promise.all(
      buffers.map(async (buf) => {
        return sharp(buf)
          .resize({ height: thumbH, width: thumbW, fit: 'cover' })
          .extract({
            left: Math.round((thumbW - cropW) / 2),
            top: 0,
            width: cropW,
            height: thumbH,
          })
          .png()
          .toBuffer();
      })
    );

    // Composite side by side with gaps
    const totalWidth = cropW * ids.length + GAP * (ids.length - 1);
    const compositeImage = await sharp({
      create: {
        width: totalWidth,
        height: thumbH,
        channels: 4,
        background: { r: 10, g: 10, b: 15, alpha: 1 },
      },
    })
      .composite(
        resizedBuffers.map((buf, i) => ({
          input: buf,
          left: i * (cropW + GAP),
          top: 0,
        }))
      )
      .jpeg({ quality: 90 })
      .toBuffer();

    return new NextResponse(new Uint8Array(compositeImage), {
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (err) {
    console.error('Composite thumbnail error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Failed to generate composite' },
      { status: 500 }
    );
  }
}
