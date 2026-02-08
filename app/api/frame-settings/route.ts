import { NextResponse } from 'next/server';
import { getMergedFrameData } from '../../../lib/frameSettings';

export async function GET() {
  try {
    const mergedFrameData = getMergedFrameData();

    // Transform the data to match the FrameTemplate interface
    const frameTemplates = mergedFrameData.map(frame => ({
      id: frame.id,
      name: frame.customName || formatFrameName(frame.id),
      panelCount: frame.panelCount,
      grid: frame.gridSize,
      description: generateDescription(frame),
      edges: generateEdgesDescription(frame.panels),
      enabled: frame.enabled,
      filename: frame.filename,
      dominantPanel: frame.dominantPanel
    }));

    return NextResponse.json({ frameTemplates });
  } catch {
    // Frame manifest not available (e.g. production without local frames dir)
    // Return empty list — client falls back to DEFAULT_TEMPLATES
    return NextResponse.json({ frameTemplates: [] });
  }
}

function formatFrameName(id: string): string {
  return id
    .split('_')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function generateDescription(frame: any): string {
  if (frame.panelCount === 1) {
    return 'Single panel layout';
  }

  if (frame.gridSize.includes('x')) {
    return `${frame.panelCount} panel ${frame.gridSize} grid layout`;
  }

  return `${frame.panelCount} panel custom layout`;
}

function generateEdgesDescription(panels: any[]): string {
  if (!panels || panels.length === 0) return 'none';

  const hasTopEdge = panels.some(p => p.edgeTouch?.top);
  const hasBottomEdge = panels.some(p => p.edgeTouch?.bottom);
  const hasLeftEdge = panels.some(p => p.edgeTouch?.left);
  const hasRightEdge = panels.some(p => p.edgeTouch?.right);

  const edges = [];
  if (hasTopEdge) edges.push('top');
  if (hasBottomEdge) edges.push('bottom');
  if (hasLeftEdge) edges.push('left');
  if (hasRightEdge) edges.push('right');

  return edges.length > 0 ? edges.join(', ') : 'none';
}