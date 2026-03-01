/**
 * Server-side leaderboard thread generation.
 * Extracted from app/admin/x-posts/page.tsx generateThread().
 */

export interface ThreadChannel {
  channel_id: string;
  channel_name: string;
  channel_url: string;
  subscriber_count: number | null;
  total_video_count: number | null;
  age_days: number | null;
  total_views: number;
  niche: string;
  ai_category: string | null;
  ai_niche: string | null;
  ai_sub_niche: string | null;
  content_style: string | null;
  is_ai_generated: boolean | null;
  channel_summary: string | null;
  ai_tags: string[] | null;
  ai_language: string | null;
  videos: { video_id: string; view_count: number }[];
}

function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined) return '?';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

function formatLoud(n: number | null | undefined, unit: string): string {
  if (n === null || n === undefined) return `? ${unit}`;
  if (n >= 1000000) {
    const val = n / 1000000;
    return `${val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)} MILLION ${unit}`;
  }
  return `${n.toLocaleString('en-US')} ${unit}`;
}

function formatAge(days: number | null): string {
  if (days === null) return '?';
  if (days < 30) return `${days} days`;
  if (days < 365) return `${Math.round(days / 30)} months`;
  return `${(days / 365).toFixed(1)} years`;
}

function getTopVideo(videos: { video_id: string; view_count: number }[]): { video_id: string; view_count: number } | null {
  if (!videos || videos.length === 0) return null;
  return videos.reduce((best, v) =>
    (Number(v.view_count) || 0) > (Number(best.view_count) || 0) ? v : best
  , videos[0]);
}

export function generateLeaderboardThread(channels: ThreadChannel[]): { text: string }[] {
  if (channels.length === 0) return [];
  const top5 = channels.slice(0, 5);
  const tweets: { text: string }[] = [];

  // Build sneak-peek lines for the hook
  const peeks = top5.map(ch => {
    const topVid = getTopVideo(ch.videos);
    const views = Number(topVid?.view_count) || 0;
    const ai = ch.is_ai_generated === true ? ' · AI generated' : '';
    return `→ ${formatLoud(ch.subscriber_count, 'subs')} · ${formatLoud(views, 'views')} in ${formatAge(ch.age_days)}${ai}`;
  }).join('\n');

  // T1 — hook
  tweets.push({
    text: `5 YouTube Shorts channels blowing up right now:\n\n${peeks}\n\nEach one grew from zero. Here's what they're doing`,
  });

  // T2–T6 — one channel each
  top5.forEach((ch, i) => {
    const topVideo = getTopVideo(ch.videos);
    const topVideoViews = Number(topVideo?.view_count) || 0;
    const nicheLabel = [ch.ai_category, ch.ai_niche].filter(Boolean).join(' > ') || ch.niche;
    const style = ch.content_style ? `\n▸ Style: ${ch.content_style.replace('_', ' ')}` : '';
    const lang = ch.ai_language ? `\n▸ Language: ${ch.ai_language.toUpperCase()}` : '';
    const aiLabel = ch.is_ai_generated === true ? '\n▸ AI generated' : '';
    const summaryLine = ch.channel_summary ? `\n\n${ch.channel_summary}` : '';
    const tagLine = ch.ai_tags?.length ? `\n\n${ch.ai_tags.slice(0, 4).map(t => `#${t}`).join(' ')}` : '';

    const growthHook = `${formatLoud(ch.subscriber_count, 'SUBS')} · ${formatLoud(topVideoViews, 'views')} in ${formatAge(ch.age_days)}.`;

    tweets.push({
      text: `${i + 1}/ ${growthHook}\n\n${ch.channel_name}\n\n▸ Niche: ${nicheLabel}\n▸ Top video: ${formatNumber(topVideoViews)} views${style}${lang}${aiLabel}${summaryLine}${tagLine}`,
    });
  });

  // T7 — CTA
  tweets.push({
    text: `You're seeing these channels before anyone else.\n\nFollow @evgeniirofe — we find them every day.`,
  });

  return tweets;
}
