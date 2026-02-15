import React from 'react';
import { spring, useCurrentFrame, useVideoConfig } from 'remotion';

interface AnimatedNumberProps {
  value: number;
  startFrame: number;
  format?: (n: number) => string;
  style?: React.CSSProperties;
}

function defaultFormat(n: number): string {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return Math.round(n).toString();
}

export const AnimatedNumber: React.FC<AnimatedNumberProps> = ({
  value,
  startFrame,
  format = defaultFormat,
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const progress = spring({
    frame: frame - startFrame,
    fps,
    config: { damping: 15, stiffness: 80, mass: 0.5 },
  });

  const currentValue = Math.round(value * Math.min(progress, 1));

  return <span style={style}>{format(currentValue)}</span>;
};
