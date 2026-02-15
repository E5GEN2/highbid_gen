import React from 'react';
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  spring,
  interpolate,
  Img,
} from 'remotion';
import { GradientBackground } from '../components/GradientBackground';
import { AnimatedNumber } from '../components/AnimatedNumber';
import { GlowText } from '../components/GlowText';
import { NicheBadge } from '../components/NicheBadge';
import { StatPill } from '../components/StatPill';
import { VideoClipPanel } from '../components/VideoClipPanel';
import { WatermarkFooter } from '../components/WatermarkFooter';
import { PostTextOverlay } from '../components/PostTextOverlay';
import type { ChannelSpotlightVideoProps } from '../../lib/remotion/types';

function formatNumber(n: number | null): string {
  if (n === null || n === undefined) return '?';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

function formatAge(days: number | null): string {
  if (days === null) return '?';
  if (days < 30) return `${days} days`;
  if (days < 365) return `${Math.round(days / 30)} months`;
  return `${(days / 365).toFixed(1)} years`;
}

export const ChannelSpotlightVideo: React.FC<ChannelSpotlightVideoProps> = ({
  channel,
  clipPaths,
  postText,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Phase timing
  const AVATAR_START = 0;
  const STATS_START = 45; // 1.5s
  const CLIPS_START = 90; // 3s
  const SUMMARY_START = 180; // 6s
  const TEXT_START = 240; // 8s

  // Avatar entrance
  const avatarScale = spring({
    frame,
    fps,
    config: { damping: 10, stiffness: 80, mass: 0.8 },
  });

  // Name type-in effect
  const nameChars = Math.floor(interpolate(frame, [10, 35], [0, channel.channel_name.length], { extrapolateRight: 'clamp' }));
  const displayName = channel.channel_name.slice(0, nameChars);

  return (
    <AbsoluteFill style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
      <GradientBackground />

      {/* Avatar + Name */}
      <div style={{ position: 'absolute', top: 50, left: 0, right: 0, textAlign: 'center' }}>
        <div style={{ display: 'inline-block', transform: `scale(${avatarScale})` }}>
          {channel.avatar_url ? (
            <Img
              src={channel.avatar_url}
              style={{ width: 80, height: 80, borderRadius: '50%', border: '3px solid rgba(255,255,255,0.2)' }}
            />
          ) : (
            <div style={{
              width: 80, height: 80, borderRadius: '50%', background: '#374151',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontSize: 32, fontWeight: 700,
              border: '3px solid rgba(255,255,255,0.2)',
            }}>
              {(channel.channel_name?.[0] ?? '?').toUpperCase()}
            </div>
          )}
        </div>

        <div style={{ fontSize: 28, fontWeight: 800, color: '#fff', marginTop: 12, minHeight: 36 }}>
          {displayName}
          {nameChars < channel.channel_name.length && (
            <span style={{ opacity: frame % 10 < 5 ? 1 : 0, color: '#a78bfa' }}>|</span>
          )}
        </div>

        <div style={{ marginTop: 8 }}>
          <NicheBadge niche={channel.niche} startFrame={25} />
          {channel.sub_niche && (
            <span style={{
              opacity: interpolate(frame - 30, [0, 10], [0, 1], { extrapolateRight: 'clamp' }),
              fontSize: 13, color: '#9ca3af', marginLeft: 8,
            }}>
              {channel.sub_niche}
            </span>
          )}
        </div>
      </div>

      {/* Stats grid */}
      <div style={{ position: 'absolute', top: 260, left: 32, right: 32, display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <StatPill label="Subscribers" value={formatNumber(channel.subscriber_count)} startFrame={STATS_START} />
        <StatPill label="Age" value={formatAge(channel.age_days)} startFrame={STATS_START + 8} />
        <StatPill label="Total Views" value={formatNumber(channel.total_views)} startFrame={STATS_START + 16} />
        <StatPill label="Videos" value={channel.video_count?.toString() ?? '?'} startFrame={STATS_START + 24} />
      </div>

      {/* Video clip panels */}
      {clipPaths.length > 0 && (
        <div style={{
          position: 'absolute',
          top: 460,
          left: 32,
          right: 32,
          display: 'flex',
          gap: 10,
          justifyContent: 'center',
          alignItems: 'center',
        }}>
          {clipPaths.length >= 1 && (
            <VideoClipPanel
              src={clipPaths[0]}
              startFrame={CLIPS_START}
              width={clipPaths.length === 1 ? 500 : 300}
              height={clipPaths.length === 1 ? 300 : 200}
              borderRadius={16}
            />
          )}
          {clipPaths.length >= 2 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <VideoClipPanel src={clipPaths[1]} startFrame={CLIPS_START + 15} width={200} height={95} borderRadius={12} />
              {clipPaths.length >= 3 && (
                <VideoClipPanel src={clipPaths[2]} startFrame={CLIPS_START + 30} width={200} height={95} borderRadius={12} />
              )}
            </div>
          )}
        </div>
      )}

      {/* Summary + Tags */}
      {(channel.channel_summary || channel.tags) && frame >= SUMMARY_START && (
        <div
          style={{
            position: 'absolute',
            top: clipPaths.length > 0 ? 690 : 460,
            left: 40,
            right: 40,
            opacity: interpolate(frame - SUMMARY_START, [0, 15], [0, 1], { extrapolateRight: 'clamp' }),
          }}
        >
          {channel.channel_summary && (
            <div style={{ fontSize: 14, color: '#d1d5db', lineHeight: 1.5, marginBottom: 10 }}>
              {channel.channel_summary.length > 150 ? channel.channel_summary.slice(0, 147) + '...' : channel.channel_summary}
            </div>
          )}
          {channel.tags && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {channel.tags.slice(0, 5).map((tag, i) => (
                <span
                  key={i}
                  style={{
                    background: 'rgba(147, 51, 234, 0.2)',
                    border: '1px solid rgba(147, 51, 234, 0.3)',
                    borderRadius: 12,
                    padding: '4px 10px',
                    fontSize: 12,
                    color: '#c4b5fd',
                    opacity: interpolate(frame - (SUMMARY_START + 10 + i * 5), [0, 8], [0, 1], { extrapolateRight: 'clamp' }),
                  }}
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Post text */}
      {postText && <PostTextOverlay text={postText} startFrame={TEXT_START} />}

      <WatermarkFooter startFrame={TEXT_START} />
    </AbsoluteFill>
  );
};
