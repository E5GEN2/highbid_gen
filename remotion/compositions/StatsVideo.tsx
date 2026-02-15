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
import { WatermarkFooter } from '../components/WatermarkFooter';
import { PostTextOverlay } from '../components/PostTextOverlay';
import { ACCENT } from '../styles/colors';
import type { StatsVideoProps } from '../../lib/remotion/types';

function formatNumber(n: number | null): string {
  if (n === null || n === undefined) return '?';
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toString();
}

export const StatsVideo: React.FC<StatsVideoProps> = ({
  totalChannels,
  totalViews,
  avgAgeDays,
  contentStyles,
  topChannel,
  postText,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Phase timing (240 frames = 8s)
  const HERO_START = 0;
  const SECONDARY_START = 60; // 2s
  const CHART_START = 100; // 3.3s
  const SPOTLIGHT_START = 150; // 5s
  const TEXT_START = 190; // 6.3s

  // Sort content styles
  const styleEntries = Object.entries(contentStyles).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxStyleCount = styleEntries.length > 0 ? styleEntries[0][1] : 1;

  return (
    <AbsoluteFill style={{ fontFamily: 'Inter, system-ui, sans-serif' }}>
      <GradientBackground />

      {/* Hero number */}
      <div style={{ position: 'absolute', top: 80, left: 0, right: 0, textAlign: 'center' }}>
        <div style={{ fontSize: 13, color: '#6b7280', textTransform: 'uppercase', letterSpacing: '0.15em', marginBottom: 8 }}>
          Channels Discovered Today
        </div>
        <div style={{ fontSize: 96, fontWeight: 900, color: '#fff' }}>
          <AnimatedNumber
            value={totalChannels}
            startFrame={HERO_START + 5}
            format={(n) => Math.round(n).toString()}
          />
        </div>

        {/* Overshoot glow */}
        {frame > 15 && frame < 45 && (
          <div
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 200,
              height: 200,
              borderRadius: '50%',
              background: `radial-gradient(circle, ${ACCENT.purple}30 0%, transparent 70%)`,
              opacity: interpolate(frame - 15, [0, 30], [0.8, 0], { extrapolateRight: 'clamp' }),
            }}
          />
        )}
      </div>

      {/* Secondary stats */}
      <div
        style={{
          position: 'absolute',
          top: 280,
          left: 60,
          right: 60,
          display: 'flex',
          justifyContent: 'space-around',
          opacity: interpolate(frame - SECONDARY_START, [0, 12], [0, 1], { extrapolateRight: 'clamp' }),
          transform: `translateY(${interpolate(frame - SECONDARY_START, [0, 12], [20, 0], { extrapolateRight: 'clamp' })}px)`,
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 32, fontWeight: 700, color: '#60a5fa' }}>
            <AnimatedNumber value={avgAgeDays} startFrame={SECONDARY_START + 5} format={(n) => `${Math.round(n)}d`} />
          </div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>AVG AGE</div>
        </div>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 32, fontWeight: 700, color: '#34d399' }}>
            <AnimatedNumber value={totalViews} startFrame={SECONDARY_START + 10} />
          </div>
          <div style={{ fontSize: 12, color: '#6b7280', marginTop: 4 }}>TOTAL VIEWS</div>
        </div>
      </div>

      {/* Bar chart */}
      {styleEntries.length > 0 && (
        <div style={{ position: 'absolute', top: 400, left: 50, right: 50 }}>
          <div style={{
            fontSize: 13,
            color: '#6b7280',
            marginBottom: 12,
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            opacity: interpolate(frame - CHART_START, [0, 10], [0, 1], { extrapolateRight: 'clamp' }),
          }}>
            Content Styles
          </div>
          {styleEntries.map(([style, count], i) => {
            const barStart = CHART_START + 10 + i * 8;
            const barWidth = interpolate(
              frame - barStart,
              [0, 20],
              [0, (count / maxStyleCount) * 100],
              { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
            );
            const barOpacity = interpolate(frame - barStart, [0, 8], [0, 1], { extrapolateRight: 'clamp' });

            return (
              <div key={style} style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, opacity: barOpacity }}>
                <div style={{ width: 100, fontSize: 12, color: '#9ca3af', textAlign: 'right', flexShrink: 0 }}>
                  {style}
                </div>
                <div style={{ flex: 1, height: 24, background: 'rgba(255,255,255,0.05)', borderRadius: 6, overflow: 'hidden' }}>
                  <div
                    style={{
                      width: `${barWidth}%`,
                      height: '100%',
                      background: `linear-gradient(90deg, ${ACCENT.purple}, ${ACCENT.pink})`,
                      borderRadius: 6,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'flex-end',
                      paddingRight: 8,
                    }}
                  >
                    {barWidth > 20 && (
                      <span style={{ fontSize: 11, color: '#fff', fontWeight: 600 }}>{count}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Top channel mini-spotlight */}
      {frame >= SPOTLIGHT_START && (
        <div
          style={{
            position: 'absolute',
            top: 680,
            left: 50,
            right: 50,
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            background: 'rgba(255,255,255,0.05)',
            borderRadius: 16,
            padding: '14px 18px',
            border: '1px solid rgba(255,255,255,0.08)',
            opacity: interpolate(frame - SPOTLIGHT_START, [0, 12], [0, 1], { extrapolateRight: 'clamp' }),
            transform: `translateY(${interpolate(frame - SPOTLIGHT_START, [0, 12], [15, 0], { extrapolateRight: 'clamp' })}px)`,
          }}
        >
          {topChannel.avatar_url ? (
            <Img src={topChannel.avatar_url} style={{ width: 44, height: 44, borderRadius: '50%', flexShrink: 0 }} />
          ) : (
            <div style={{
              width: 44, height: 44, borderRadius: '50%', background: '#374151',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontSize: 18, fontWeight: 700, flexShrink: 0,
            }}>
              {(topChannel.channel_name?.[0] ?? '?').toUpperCase()}
            </div>
          )}
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#fff' }}>{topChannel.channel_name}</div>
            <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
              {formatNumber(topChannel.subscriber_count)} subs · {topChannel.age_days}d old · Top channel today
            </div>
          </div>
          <div style={{ fontSize: 11, color: '#f59e0b', fontWeight: 700, flexShrink: 0 }}>
            #1
          </div>
        </div>
      )}

      {postText && <PostTextOverlay text={postText} startFrame={TEXT_START} />}
      <WatermarkFooter startFrame={TEXT_START} />
    </AbsoluteFill>
  );
};
