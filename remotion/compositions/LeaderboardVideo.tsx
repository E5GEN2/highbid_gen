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
import { WatermarkFooter } from '../components/WatermarkFooter';
import { PostTextOverlay } from '../components/PostTextOverlay';
import { getNicheColorHex } from '../styles/colors';
import type { LeaderboardVideoProps } from '../../lib/remotion/types';

function formatNumber(n: number | null): string {
  if (n === null || n === undefined) return '?';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

function formatAge(days: number | null): string {
  if (days === null) return '?';
  if (days < 30) return `${days}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
}

export const LeaderboardVideo: React.FC<LeaderboardVideoProps> = ({
  channels,
  date,
  postText,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const top5 = channels.slice(0, 5);

  // Phase timing (frames at 30fps)
  const TITLE_START = 0;
  const ROWS_START = 30; // 1s
  const GLOW_START = 160; // ~5.3s
  const TEXT_START = 210; // 7s
  const CTA_START = 250; // ~8.3s

  // Title fade-in
  const titleOpacity = interpolate(frame, [TITLE_START, TITLE_START + 15], [0, 1], { extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
      <GradientBackground />

      {/* Header */}
      <div
        style={{
          position: 'absolute',
          top: 40,
          left: 40,
          right: 40,
          opacity: titleOpacity,
        }}
      >
        <div style={{ fontSize: 12, color: '#9ca3af', letterSpacing: '0.15em', textTransform: 'uppercase' }}>
          rofe.ai
        </div>
        <GlowText
          text="Today's Fastest Growing"
          startFrame={TITLE_START + 5}
          fontSize={32}
          glowColor="#9333ea"
          style={{ marginTop: 8 }}
        />
        <div style={{ fontSize: 14, color: '#6b7280', marginTop: 4 }}>{date}</div>
      </div>

      {/* Ranked rows */}
      <div style={{ position: 'absolute', top: 160, left: 32, right: 32 }}>
        {top5.map((ch, i) => {
          const rowStart = ROWS_START + i * 26; // staggered ~0.87s apart
          const relFrame = frame - rowStart;

          const slideX = spring({
            frame: relFrame,
            fps,
            config: { damping: 14, stiffness: 80 },
          });
          const translateX = interpolate(slideX, [0, 1], [-400, 0]);
          const opacity = interpolate(relFrame, [0, 10], [0, 1], { extrapolateRight: 'clamp' });

          // #1 glow pulse after GLOW_START
          const isFirst = i === 0;
          const glowPhase = frame - GLOW_START;
          const glowIntensity = isFirst && glowPhase > 0
            ? interpolate(Math.sin(glowPhase * 0.15) * 0.5 + 0.5, [0, 1], [0, 12])
            : 0;

          const avatarScale = spring({
            frame: relFrame - 5,
            fps,
            config: { damping: 10, stiffness: 150 },
          });

          if (relFrame < 0) return null;

          return (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                background: 'rgba(255,255,255,0.05)',
                borderRadius: 16,
                padding: '14px 16px',
                marginBottom: 10,
                opacity,
                transform: `translateX(${translateX}px)`,
                boxShadow: glowIntensity > 0
                  ? `0 0 ${glowIntensity}px ${getNicheColorHex(ch.niche)}, inset 0 0 ${glowIntensity / 2}px ${getNicheColorHex(ch.niche)}40`
                  : 'none',
                border: `1px solid rgba(255,255,255,${isFirst && glowPhase > 0 ? 0.15 : 0.05})`,
              }}
            >
              {/* Rank */}
              <div style={{ fontSize: 28, fontWeight: 800, color: '#4b5563', width: 36, textAlign: 'center', flexShrink: 0 }}>
                {i + 1}
              </div>

              {/* Avatar */}
              <div style={{ transform: `scale(${avatarScale})`, flexShrink: 0 }}>
                {ch.avatar_url ? (
                  <Img src={ch.avatar_url} style={{ width: 44, height: 44, borderRadius: '50%' }} />
                ) : (
                  <div style={{
                    width: 44, height: 44, borderRadius: '50%', background: '#374151',
                    display: 'flex', alignItems: 'center', justifyContent: 'center',
                    color: '#fff', fontSize: 18, fontWeight: 700,
                  }}>
                    {(ch.channel_name?.[0] ?? '?').toUpperCase()}
                  </div>
                )}
              </div>

              {/* Info */}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: '#fff', fontSize: 16, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {ch.channel_name}
                </div>
                <div style={{ display: 'flex', gap: 8, fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                  <AnimatedNumber value={ch.subscriber_count || 0} startFrame={rowStart + 10} />
                  <span>subs</span>
                  <span style={{ color: '#4b5563' }}>·</span>
                  <span>{formatAge(ch.age_days)}</span>
                  <span style={{ color: '#4b5563' }}>·</span>
                  <AnimatedNumber value={ch.velocity} startFrame={rowStart + 10} />
                  <span>v/d</span>
                </div>
              </div>

              {/* Niche badge */}
              <NicheBadge niche={ch.niche} startFrame={rowStart + 8} style={{ fontSize: 11, padding: '4px 10px' }} />
            </div>
          );
        })}
      </div>

      {/* Post text overlay */}
      {postText && <PostTextOverlay text={postText} startFrame={TEXT_START} />}

      {/* CTA */}
      {frame >= CTA_START && (
        <div
          style={{
            position: 'absolute',
            bottom: postText ? 150 : 80,
            left: 0,
            right: 0,
            textAlign: 'center',
            opacity: interpolate(frame - CTA_START, [0, 15], [0, 1], { extrapolateRight: 'clamp' }),
          }}
        >
          <span style={{ fontSize: 16, fontWeight: 700, color: '#a78bfa' }}>
            Follow @rofe_ai
          </span>
        </div>
      )}

      <WatermarkFooter startFrame={CTA_START} />
    </AbsoluteFill>
  );
};
