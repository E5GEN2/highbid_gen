import React from 'react';
import { spring, useCurrentFrame, useVideoConfig, interpolate } from 'remotion';

interface StatPillProps {
  label: string;
  value: string;
  startFrame: number;
  color?: string;
  style?: React.CSSProperties;
}

export const StatPill: React.FC<StatPillProps> = ({
  label,
  value,
  startFrame,
  color = '#374151',
  style,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const relFrame = frame - startFrame;

  const scale = spring({
    frame: relFrame,
    fps,
    config: { damping: 12, stiffness: 100 },
  });

  const opacity = interpolate(relFrame, [0, 8], [0, 1], { extrapolateRight: 'clamp' });

  if (relFrame < 0) return null;

  return (
    <div
      style={{
        opacity,
        transform: `scale(${scale})`,
        background: `${color}30`,
        border: `1px solid ${color}60`,
        borderRadius: 12,
        padding: '12px 16px',
        textAlign: 'center',
        ...style,
      }}
    >
      <div style={{ color: '#ffffff', fontSize: 22, fontWeight: 700 }}>{value}</div>
      <div style={{ color: '#9ca3af', fontSize: 11, marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {label}
      </div>
    </div>
  );
};
