import React from 'react';
import { Composition, registerRoot } from 'remotion';
import { LeaderboardVideo } from './compositions/LeaderboardVideo';
import { ChannelSpotlightVideo } from './compositions/ChannelSpotlightVideo';
import { StatsVideo } from './compositions/StatsVideo';
import { NicheRoundupVideo } from './compositions/NicheRoundupVideo';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="LeaderboardVideo"
        component={LeaderboardVideo as React.FC}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          channels: [],
          date: new Date().toISOString().split('T')[0],
          postText: '',
        }}
      />
      <Composition
        id="ChannelSpotlightVideo"
        component={ChannelSpotlightVideo as React.FC}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          channel: {
            channel_name: 'Channel',
            avatar_url: null,
            niche: 'General',
            sub_niche: null,
            subscriber_count: 0,
            age_days: 0,
            total_views: 0,
            video_count: 0,
            content_style: null,
            channel_summary: null,
            tags: null,
          },
          clipPaths: [],
          postText: '',
        }}
      />
      <Composition
        id="StatsVideo"
        component={StatsVideo as React.FC}
        durationInFrames={240}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          totalChannels: 0,
          totalViews: 0,
          avgAgeDays: 0,
          contentStyles: {},
          categories: [],
          topChannel: {
            channel_name: 'Channel',
            avatar_url: null,
            subscriber_count: 0,
            age_days: 0,
          },
          postText: '',
        }}
      />
      <Composition
        id="NicheRoundupVideo"
        component={NicheRoundupVideo as React.FC}
        durationInFrames={300}
        fps={30}
        width={1080}
        height={1080}
        defaultProps={{
          nicheName: 'General',
          channels: [],
          combinedViews: 0,
          clipPaths: [],
          postText: '',
        }}
      />
    </>
  );
};

registerRoot(RemotionRoot);
