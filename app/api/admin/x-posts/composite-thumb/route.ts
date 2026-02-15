import { NextRequest, NextResponse } from 'next/server';
import sharp from 'sharp';
import { getPool } from '../../../../../lib/db';

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

async function getYouTubeApiKey(): Promise<string | null> {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT value FROM admin_config WHERE key = $1`,
    ['youtube_api_key']
  );
  return result.rows[0]?.value || process.env.YOUTUBE_API_KEY || null;
}

async function fetchChannelVideoIds(channelId: string, apiKey: string, count = 5): Promise<string[]> {
  try {
    // Search for recent Shorts from this channel
    const url = `https://www.googleapis.com/youtube/v3/search?part=id&channelId=${channelId}&type=video&order=viewCount&maxResults=${count}&key=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.items || []).map((item: { id: { videoId: string } }) => item.id.videoId).filter(Boolean);
  } catch {
    return [];
  }
}

export async function GET(req: NextRequest) {
  if (!checkAuth(req)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const providedIds = req.nextUrl.searchParams.get('ids')?.split(',').filter(Boolean) || [];
  const channelId = req.nextUrl.searchParams.get('channelId');
  const TARGET = 3;
  const GAP = 8;

  try {
    let ids = [...new Set(providedIds)].slice(0, TARGET);

    // If we don't have enough, fetch more from YouTube API
    if (ids.length < TARGET && channelId) {
      const apiKey = await getYouTubeApiKey();
      if (apiKey) {
        const extraIds = await fetchChannelVideoIds(channelId, apiKey, TARGET + 2);
        for (const id of extraIds) {
          if (!ids.includes(id)) ids.push(id);
          if (ids.length >= TARGET) break;
        }
      }
    }

    if (ids.length === 0) {
      return NextResponse.json({ error: 'No video IDs available' }, { status: 400 });
    }

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
    const count = resizedBuffers.length;
    const totalWidth = cropW * count + GAP * (count - 1);
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
      { status: 500 },
    );
  }
}
