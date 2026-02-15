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
import type { NicheRoundupVideoProps } from '../../lib/remotion/types';

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

export const NicheRoundupVideo: React.FC<NicheRoundupVideoProps> = ({
  nicheName,
  channels,
  combinedViews,
  postText,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Phase timing (300 frames = 10s)
  const TITLE_START = 0;
  const CARDS_START = 50; // 1.67s
  const COMBINED_START = 200; // 6.67s
  const TEXT_START = 250; // 8.3s

  const nicheColor = getNicheColorHex(nicheName);

  return (
    <AbsoluteFill style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
      <GradientBackground />

      {/* Niche title */}
      <div style={{ position: 'absolute', top: 60, left: 0, right: 0, textAlign: 'center' }}>
        <GlowText
          text={nicheName}
          startFrame={TITLE_START}
          fontSize={52}
          glowColor={nicheColor}
        />
        <div
          style={{
            fontSize: 18,
            color: '#9ca3af',
            marginTop: 12,
            opacity: interpolate(frame - 15, [0, 10], [0, 1], { extrapolateRight: 'clamp' }),
          }}
        >
          <AnimatedNumber
            value={channels.length}
            startFrame={15}
            format={(n) => `${Math.round(n)} channel${Math.round(n) !== 1 ? 's' : ''} discovered`}
          />
        </div>
      </div>

      {/* Channel cards */}
      <div style={{ position: 'absolute', top: 200, left: 32, right: 32 }}>
        {channels.slice(0, 6).map((ch, i) => {
          const cardStart = CARDS_START + i * 35;
          const relFrame = frame - cardStart;

          const slideX = spring({
            frame: relFrame,
            fps,
            config: { damping: 14, stiffness: 90 },
          });
          const translateX = interpolate(slideX, [0, 1], [i % 2 === 0 ? -300 : 300, 0]);
          const opacity = interpolate(relFrame, [0, 10], [0, 1], { extrapolateRight: 'clamp' });

          if (relFrame < 0) return null;

          return (
            <div
              key={i}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                background: 'rgba(255,255,255,0.05)',
                borderRadius: 14,
                padding: '12px 16px',
                marginBottom: 8,
                opacity,
                transform: `translateX(${translateX}px)`,
                border: '1px solid rgba(255,255,255,0.06)',
              }}
            >
              {ch.avatar_url ? (
                <Img src={ch.avatar_url} style={{ width: 40, height: 40, borderRadius: '50%', flexShrink: 0 }} />
              ) : (
                <div style={{
                  width: 40, height: 40, borderRadius: '50%', background: '#374151',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  color: '#fff', fontSize: 16, fontWeight: 700, flexShrink: 0,
                }}>
                  {(ch.channel_name?.[0] ?? '?').toUpperCase()}
                </div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: '#fff', fontSize: 15, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {ch.channel_name}
                </div>
                <div style={{ display: 'flex', gap: 8, fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                  {ch.sub_niche && <span style={{ color: '#a78bfa' }}>{ch.sub_niche}</span>}
                  <span>{formatNumber(ch.subscriber_count)} subs</span>
                  <span style={{ color: '#4b5563' }}>·</span>
                  <span>{formatAge(ch.age_days)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Combined views */}
      {frame >= COMBINED_START && (
        <div
          style={{
            position: 'absolute',
            bottom: postText ? 180 : 120,
            left: 0,
            right: 0,
            textAlign: 'center',
            opacity: interpolate(frame - COMBINED_START, [0, 15], [0, 1], { extrapolateRight: 'clamp' }),
          }}
        >
          <div style={{ fontSize: 13, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>
            Combined Views
          </div>
          <div style={{ fontSize: 40, fontWeight: 800, color: '#fff' }}>
            <AnimatedNumber value={combinedViews} startFrame={COMBINED_START + 5} />
          </div>
        </div>
      )}

      {postText && <PostTextOverlay text={postText} startFrame={TEXT_START} />}
      <WatermarkFooter startFrame={TEXT_START} />
    </AbsoluteFill>
  );
};
