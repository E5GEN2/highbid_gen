import React from 'react';
import { spring, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';
import { getNicheColorHex } from '../styles/colors';

interface NicheBadgeProps {
  niche: string;
  startFrame: number;
  style?: React.CSSProperties;
}

export const NicheBadge: React.FC<NicheBadgeProps> = ({
  niche,
  startFrame,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const relFrame = frame - startFrame;

  const slideX = interpolate(relFrame, [0, 12], [60, 0], { extrapolateRight: 'clamp' });
  const opacity = interpolate(relFrame, [0, 8], [0, 1], { extrapolateRight: 'clamp' });
  const scale = spring({
    frame: relFrame,
    fps,
    config: { damping: 14, stiffness: 120 },
  });

  if (relFrame < 0) return null;

  const bgColor = getNicheColorHex(niche);

  return (
    <div
      style={{
        display: 'inline-block',
        opacity,
        transform: `translateX(${slideX}px) scale(${scale})`,
        backgroundColor: bgColor,
        borderRadius: 20,
        padding: '6px 16px',
        fontSize: 14,
        fontWeight: 700,
        color: '#ffffff',
        letterSpacing: '0.02em',
        ...style,
      }}
    >
      {niche}
    </div>
  );
};
