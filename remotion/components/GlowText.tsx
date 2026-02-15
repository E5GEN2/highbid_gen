import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';

interface GlowTextProps {
  text: string;
  startFrame: number;
  duration?: number;
  fontSize?: number;
  color?: string;
  glowColor?: string;
  style?: React.CSSProperties;
}

export const GlowText: React.FC<GlowTextProps> = ({
  text,
  startFrame,
  duration = 20,
  fontSize = 48,
  color = '#ffffff',
  glowColor = '#9333ea',
  style,
}) => {
  const frame = useCurrentFrame();
  const relFrame = frame - startFrame;

  const opacity = interpolate(relFrame, [0, 10], [0, 1], { extrapolateRight: 'clamp' });
  const glowIntensity = interpolate(
    relFrame,
    [5, duration * 0.5, duration],
    [0, 20, 8],
    { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }
  );

  if (relFrame < 0) return null;

  return (
    <div
      style={{
        opacity,
        fontSize,
        fontWeight: 800,
        color,
        textShadow: `0 0 ${glowIntensity}px ${glowColor}, 0 0 ${glowIntensity * 2}px ${glowColor}40`,
        letterSpacing: '-0.02em',
        ...style,
      }}
    >
      {text}
    </div>
  );
};
