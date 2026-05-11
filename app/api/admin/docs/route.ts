import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import fs from 'fs/promises';
import path from 'path';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /api/admin/docs              → list of available docs
 * GET /api/admin/docs?slug=<name>  → raw markdown content of one doc
 *
 * Reads from the repo's /docs directory at runtime. Slugs are the
 * filename without the .md extension. Markdown is rendered client-side
 * (see admin/page.tsx → DocsTab) so this endpoint stays a thin
 * filesystem wrapper.
 */

const DOCS_DIR = path.join(process.cwd(), 'docs');

interface DocEntry {
  slug: string;
  title: string;       // parsed from the file's first H1, falls back to slug
  description: string; // first paragraph after the H1 (under 200 chars)
  size: number;
  mtime: string;
}

function parseTitleAndDesc(md: string, fallbackSlug: string): { title: string; description: string } {
  const lines = md.split('\n');
  let title = fallbackSlug;
  let description = '';
  let i = 0;
  // First non-empty line that's an H1
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.startsWith('# ')) { title = line.slice(2).trim(); i++; break; }
    if (line) break;            // hit non-header non-empty content — abort H1 search
    i++;
  }
  // First non-empty paragraph after the H1
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line && !line.startsWith('#')) {
      description = line.slice(0, 200);
      break;
    }
    i++;
  }
  return { title, description };
}

export async function GET(req: NextRequest) {
  if (!await isAdmin(req)) return NextResponse.json({ error: 'Admin access required' }, { status: 403 });
  const slug = req.nextUrl.searchParams.get('slug');

  if (slug) {
    // Only allow simple slugs — no path traversal.
    if (!/^[a-zA-Z0-9_-]+$/.test(slug)) {
      return NextResponse.json({ error: 'Invalid slug' }, { status: 400 });
    }
    const file = path.join(DOCS_DIR, `${slug}.md`);
    try {
      const content = await fs.readFile(file, 'utf-8');
      const stat = await fs.stat(file);
      const { title, description } = parseTitleAndDesc(content, slug);
      return NextResponse.json({
        slug, title, description, content,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    } catch {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
  }

  // List mode
  let files: string[];
  try {
    files = await fs.readdir(DOCS_DIR);
  } catch {
    return NextResponse.json({ docs: [] });
  }
  const md = files.filter(f => f.endsWith('.md'));
  const docs: DocEntry[] = [];
  for (const f of md) {
    const slug = f.replace(/\.md$/, '');
    try {
      const content = await fs.readFile(path.join(DOCS_DIR, f), 'utf-8');
      const stat = await fs.stat(path.join(DOCS_DIR, f));
      const meta = parseTitleAndDesc(content, slug);
      docs.push({
        slug,
        title: meta.title,
        description: meta.description,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    } catch {
      // skip unreadable
    }
  }
  // Sort: most recently modified first.
  docs.sort((a, b) => b.mtime.localeCompare(a.mtime));
  return NextResponse.json({ docs });
}
