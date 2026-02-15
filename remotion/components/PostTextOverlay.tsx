import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';

interface PostTextOverlayProps {
  text: string;
  startFrame: number;
  style?: React.CSSProperties;
}

export const PostTextOverlay: React.FC<PostTextOverlayProps> = ({
  text,
  startFrame,
  style,
}) => {
  const frame = useCurrentFrame();
  const relFrame = frame - startFrame;

  const opacity = interpolate(relFrame, [0, 20], [0, 1], { extrapolateRight: 'clamp' });
  const translateY = interpolate(relFrame, [0, 20], [20, 0], { extrapolateRight: 'clamp' });

  if (relFrame < 0) return null;

  // Truncate long text
  const displayText = text.length > 120 ? text.slice(0, 117) + '...' : text;

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 48,
        left: 32,
        right: 32,
        opacity,
        transform: `translateY(${translateY}px)`,
        ...style,
      }}
    >
      <div
        style={{
          background: 'rgba(0, 0, 0, 0.7)',
          backdropFilter: 'blur(8px)',
          borderRadius: 16,
          padding: '16px 20px',
          border: '1px solid rgba(255,255,255,0.1)',
        }}
      >
        <div style={{ fontSize: 15, color: '#e5e7eb', lineHeight: 1.4 }}>
          {displayText}
        </div>
      </div>
    </div>
  );
};
