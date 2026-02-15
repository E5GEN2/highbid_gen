import React from 'react';
import { OffthreadVideo, staticFile, interpolate, useCurrentFrame } from 'remotion';

interface VideoClipPanelProps {
  src: string;
  startFrame: number;
  width: number;
  height: number;
  borderRadius?: number;
  style?: React.CSSProperties;
}

export const VideoClipPanel: React.FC<VideoClipPanelProps> = ({
  src,
  startFrame,
  width,
  height,
  borderRadius = 16,
  style,
}) => {
  const frame = useCurrentFrame();
  const relFrame = frame - startFrame;

  const opacity = interpolate(relFrame, [0, 15], [0, 1], { extrapolateRight: 'clamp' });
  const scale = interpolate(relFrame, [0, 15], [0.9, 1], { extrapolateRight: 'clamp' });

  if (relFrame < 0) return null;

  const isStatic = src.endsWith('.jpg') || src.endsWith('.jpeg') || src.endsWith('.png') || src.endsWith('.webp');

  return (
    <div
      style={{
        width,
        height,
        borderRadius,
        overflow: 'hidden',
        opacity,
        transform: `scale(${scale})`,
        border: '2px solid rgba(255,255,255,0.1)',
        ...style,
      }}
    >
      {isStatic ? (
        <img
          src={src}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        <OffthreadVideo
          src={staticFile(src)}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          muted
        />
      )}
    </div>
  );
};
