'use client';

import React from 'react';

/**
 * Tiny markdown renderer — handles the subset our admin docs actually
 * use:
 *   - # ## ### headers
 *   - **bold** *italic* `inline code`
 *   - fenced code blocks (```lang)
 *   - GFM tables
 *   - - bulleted lists  /  1. numbered lists  (with indent → nested)
 *   - paragraphs
 *   - [link text](url)
 *   - > blockquotes
 *   - --- horizontal rules
 *
 * Intentionally not pulling in react-markdown / remark — for the docs
 * we have, this 200-line renderer is enough and keeps the bundle thin.
 */

interface Block {
  kind: 'h1' | 'h2' | 'h3' | 'h4' | 'p' | 'code' | 'ul' | 'ol' | 'quote' | 'hr' | 'table';
  content?: string;
  lang?: string;
  items?: string[];
  rows?: string[][];
  header?: string[];
  align?: Array<'left' | 'center' | 'right'>;
}

function parseBlocks(md: string): Block[] {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  function eatBlankLines() { while (i < lines.length && lines[i].trim() === '') i++; }

  while (i < lines.length) {
    eatBlankLines();
    if (i >= lines.length) break;
    const line = lines[i];

    // Fenced code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) { buf.push(lines[i]); i++; }
      if (i < lines.length) i++;          // consume the closing ```
      blocks.push({ kind: 'code', lang, content: buf.join('\n') });
      continue;
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim())) {
      blocks.push({ kind: 'hr' });
      i++;
      continue;
    }

    // Headers
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length as 1 | 2 | 3 | 4;
      const kind = (`h${level}`) as Block['kind'];
      blocks.push({ kind, content: h[2].trim() });
      i++;
      continue;
    }

    // Tables (GFM): header row | row, then separator row of dashes, then body
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[-:\s|]+\|?\s*$/.test(lines[i + 1])) {
      const header = splitRow(line);
      const sepRow = splitRow(lines[i + 1]);
      const align: Array<'left' | 'center' | 'right'> = sepRow.map(c => {
        const t = c.trim();
        const l = t.startsWith(':'); const r = t.endsWith(':');
        if (l && r) return 'center';
        if (r) return 'right';
        return 'left';
      });
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
        rows.push(splitRow(lines[i]));
        i++;
      }
      blocks.push({ kind: 'table', header, rows, align });
      continue;
    }

    // Blockquote
    if (line.startsWith('> ')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) { buf.push(lines[i].slice(2)); i++; }
      blocks.push({ kind: 'quote', content: buf.join('\n') });
      continue;
    }

    // Lists
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const isOrdered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]) || /^\s{2,}\S/.test(lines[i]))) {
        items.push(lines[i].replace(/^\s*(?:[-*]|\d+\.)\s+/, ''));
        i++;
      }
      blocks.push({ kind: isOrdered ? 'ol' : 'ul', items });
      continue;
    }

    // Paragraph — consume until blank line or special-block start
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    if (buf.length > 0) blocks.push({ kind: 'p', content: buf.join(' ') });
  }
  return blocks;
}

function splitRow(row: string): string[] {
  return row.replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
}

function isBlockStart(line: string): boolean {
  return line.startsWith('```')
      || /^#{1,4}\s/.test(line)
      || line.startsWith('> ')
      || /^---+$/.test(line.trim())
      || /^\s*[-*]\s+/.test(line)
      || /^\s*\d+\.\s+/.test(line);
}

/**
 * Inline tokenizer — bold / italic / code / links.
 * Returns a React fragment so callers can put it inside any element.
 */
function renderInline(text: string): React.ReactNode {
  // Order matters: links first (so we can capture brackets before
  // bold/italic might gobble them), then `code`, then **bold**,
  // then *italic*.
  const parts: React.ReactNode[] = [];
  let s = text;
  let idx = 0;
  // Greedy regex scan
  const tokenRegex = /(\[[^\]]+\]\([^)]+\))|(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)/g;
  let m: RegExpExecArray | null;
  let lastIndex = 0;
  while ((m = tokenRegex.exec(s)) !== null) {
    if (m.index > lastIndex) parts.push(s.slice(lastIndex, m.index));
    const tok = m[0];
    if (tok.startsWith('[')) {
      const lm = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (lm) parts.push(
        <a key={idx++} href={lm[2]} target="_blank" rel="noreferrer" className="text-emerald-400 hover:text-emerald-300 underline">
          {lm[1]}
        </a>,
      );
    } else if (tok.startsWith('`')) {
      parts.push(
        <code key={idx++} className="bg-[#1a1a1a] border border-[#262626] text-amber-300 px-1.5 py-0.5 rounded text-[12px] font-mono">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith('**')) {
      parts.push(<strong key={idx++} className="text-white font-semibold">{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('*')) {
      parts.push(<em key={idx++} className="italic">{tok.slice(1, -1)}</em>);
    }
    lastIndex = m.index + tok.length;
  }
  if (lastIndex < s.length) parts.push(s.slice(lastIndex));
  return <>{parts}</>;
}

export function Markdown({ source }: { source: string }) {
  const blocks = React.useMemo(() => parseBlocks(source), [source]);
  return (
    <div className="prose-admin space-y-4 text-[#ccc] text-sm leading-relaxed">
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'h1':
            return <h1 key={i} className="text-2xl font-bold text-white mt-2 mb-2 leading-tight">{renderInline(b.content!)}</h1>;
          case 'h2':
            return <h2 key={i} className="text-lg font-bold text-white mt-6 mb-1 leading-tight border-b border-[#222] pb-1">{renderInline(b.content!)}</h2>;
          case 'h3':
            return <h3 key={i} className="text-base font-semibold text-white mt-4 mb-1">{renderInline(b.content!)}</h3>;
          case 'h4':
            return <h4 key={i} className="text-sm font-semibold text-white mt-3 mb-1">{renderInline(b.content!)}</h4>;
          case 'hr':
            return <hr key={i} className="border-[#222] my-4" />;
          case 'p':
            return <p key={i} className="text-[#ccc]">{renderInline(b.content!)}</p>;
          case 'code':
            return (
              <pre key={i} className="bg-[#0a0a0a] border border-[#1a1a1a] rounded-lg p-3 overflow-x-auto text-[12px] font-mono text-[#ddd]">
                <code>{b.content}</code>
              </pre>
            );
          case 'ul':
            return (
              <ul key={i} className="list-disc list-outside ml-6 space-y-1">
                {b.items!.map((item, j) => <li key={j} className="text-[#ccc]">{renderInline(item)}</li>)}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i} className="list-decimal list-outside ml-6 space-y-1">
                {b.items!.map((item, j) => <li key={j} className="text-[#ccc]">{renderInline(item)}</li>)}
              </ol>
            );
          case 'quote':
            return (
              <blockquote key={i} className="border-l-2 border-fuchsia-500/50 pl-3 text-[#aaa] italic">
                {renderInline(b.content!)}
              </blockquote>
            );
          case 'table':
            return (
              <div key={i} className="overflow-x-auto">
                <table className="min-w-full text-xs border border-[#222] rounded">
                  <thead>
                    <tr className="bg-[#141414]">
                      {b.header!.map((h, j) => (
                        <th key={j} className={`px-3 py-2 text-${b.align![j] || 'left'} font-medium text-white border-b border-[#222]`}>
                          {renderInline(h)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows!.map((row, j) => (
                      <tr key={j} className="border-b border-[#1a1a1a] last:border-b-0">
                        {row.map((cell, k) => (
                          <td key={k} className={`px-3 py-2 text-${b.align![k] || 'left'} text-[#ccc]`}>
                            {renderInline(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return null;
        }
      })}
    </div>
  );
}
