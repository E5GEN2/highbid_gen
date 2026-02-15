import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';

interface WatermarkFooterProps {
  startFrame?: number;
  text?: string;
}

export const WatermarkFooter: React.FC<WatermarkFooterProps> = ({
  startFrame = 0,
  text = 'rofe.ai',
}) => {
  const frame = useCurrentFrame();
  const relFrame = frame - startFrame;

  const opacity = interpolate(relFrame, [0, 15], [0, 0.4], { extrapolateRight: 'clamp' });

  if (relFrame < 0) return null;

  return (
    <div
      style={{
        position: 'absolute',
        bottom: 24,
        left: 0,
        right: 0,
        textAlign: 'center',
        opacity,
        fontSize: 14,
        fontWeight: 600,
        color: '#ffffff',
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
      }}
    >
      {text}
    </div>
  );
};
