import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { GRADIENT_BG } from '../styles/colors';

export const GradientBackground: React.FC = () => {
  const frame = useCurrentFrame();
  const angle = interpolate(frame, [0, 300], [135, 155]);

  return (
    <AbsoluteFill
      style={{
        background: `linear-gradient(${angle}deg, ${GRADIENT_BG.start} 0%, ${GRADIENT_BG.mid} 50%, ${GRADIENT_BG.end} 100%)`,
      }}
    />
  );
};
