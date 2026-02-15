export interface LeaderboardChannel {
  channel_name: string;
  avatar_url: string | null;
  subscriber_count: number | null;
  age_days: number | null;
  velocity: number;
  niche: string;
  total_views: number;
}

export interface LeaderboardVideoProps {
  channels: LeaderboardChannel[];
  date: string;
  postText: string;
}

export interface SpotlightChannel {
  channel_name: string;
  avatar_url: string | null;
  niche: string;
  sub_niche: string | null;
  subscriber_count: number | null;
  age_days: number | null;
  total_views: number;
  video_count: number | null;
  content_style: string | null;
  channel_summary: string | null;
  tags: string[] | null;
}

export interface ChannelSpotlightVideoProps {
  channel: SpotlightChannel;
  clipPaths: string[];
  postText: string;
}

export interface StatsVideoProps {
  totalChannels: number;
  totalViews: number;
  avgAgeDays: number;
  contentStyles: Record<string, number>;
  categories: string[];
  topChannel: {
    channel_name: string;
    avatar_url: string | null;
    subscriber_count: number | null;
    age_days: number | null;
  };
  postText: string;
}

export interface NicheChannel {
  channel_name: string;
  avatar_url: string | null;
  sub_niche: string | null;
  subscriber_count: number | null;
  age_days: number | null;
}

export interface NicheRoundupVideoProps {
  nicheName: string;
  channels: NicheChannel[];
  combinedViews: number;
  clipPaths: string[];
  postText: string;
}
