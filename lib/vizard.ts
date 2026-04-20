/**
 * Vizard.ai client — submit a video URL, poll for generated clips.
 *
 * API docs: https://docs.vizard.ai/docs/basic
 * Base URL:  https://elb-api.vizard.ai/hvizard-server-front/open-api/v1
 * Auth:      header `VIZARDAI_API_KEY: <key>`
 *
 * videoUrl returned by GET /project/query/{id} is a temporary download link
 * valid for ~7 days — downstream consumers (e.g. xgodo upload) can fetch it
 * directly with no auth within that window.
 */

import { getPool } from './db';

const VIZARD_BASE = 'https://elb-api.vizard.ai/hvizard-server-front/open-api/v1';

/** YouTube / mp4 / drive / etc. — must match Vizard's videoType integers. */
export type VizardVideoType = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 9 | 10 | 11 | 12;

/** Vizard preferLength choices. 0 = auto, 1 = <30s, 2 = 30–60s, 3 = 60–90s,
 *  4 = 90s–3min. Cannot mix 0 with others. */
export type VizardPreferLength = 0 | 1 | 2 | 3 | 4;

export interface CreateProjectInput {
  videoUrl: string;
  videoType: VizardVideoType;
  lang?: string;                         // default 'auto'
  preferLength?: VizardPreferLength[];   // default [0]
  ext?: 'mp4' | '3gp' | 'avi' | 'mov';   // required when videoType === 1
}

export interface VizardCreateResponse {
  code: number;               // 2000 on success, 1000 still processing, 4xxx on error
  projectId?: number;
  errMsg?: string;
}

export interface VizardClip {
  videoId: number;
  videoUrl: string;           // temporary download URL (~7 days)
  videoMsDuration: number;
  title: string;
  transcript: string;
  viralScore: string;         // "0"–"10"
  viralReason: string;
  relatedTopic: string;       // stringified JSON array
  clipEditorUrl: string;
  disliked?: boolean;
  starred?: boolean;
}

export interface VizardQueryResponse {
  code: number;               // 2000 done, 1000 still processing, 4xxx error
  projectId?: number;
  projectName?: string;
  shareLink?: string;
  videos?: VizardClip[];
  errMsg?: string;
}

/** Fetches the Vizard API key from admin_config. Returns null if not set. */
export async function getVizardApiKey(): Promise<string | null> {
  const pool = await getPool();
  const res = await pool.query<{ value: string }>(
    `SELECT value FROM admin_config WHERE key = 'vizard_api_key' LIMIT 1`
  );
  const key = res.rows[0]?.value?.trim();
  return key || null;
}

/**
 * Detects Vizard videoType from a raw URL. Returns null when we can't tell —
 * caller should default to 1 (remote file) and require the ext.
 */
export function detectVideoType(url: string): VizardVideoType | null {
  const u = url.toLowerCase();
  if (/youtu\.be\/|youtube\.com\//.test(u)) return 2;
  if (/drive\.google\.com/.test(u)) return 3;
  if (/vimeo\.com/.test(u)) return 4;
  if (/streamyard\.com/.test(u)) return 5;
  if (/tiktok\.com/.test(u)) return 6;
  if (/twitter\.com|x\.com/.test(u)) return 7;
  if (/twitch\.tv/.test(u)) return 9;
  if (/loom\.com/.test(u)) return 10;
  if (/facebook\.com|fb\.watch/.test(u)) return 11;
  if (/linkedin\.com/.test(u)) return 12;
  if (/\.(mp4|mov|3gp|avi)(\?|$)/.test(u)) return 1;
  return null;
}

/** Extract the file extension from a direct-url when videoType === 1. */
export function detectExt(url: string): 'mp4' | 'mov' | '3gp' | 'avi' | null {
  const m = url.toLowerCase().match(/\.(mp4|mov|3gp|avi)(\?|$)/);
  if (!m) return null;
  return m[1] as 'mp4' | 'mov' | '3gp' | 'avi';
}

/** POST /project/create — submit a video URL, receive a projectId. */
export async function createVizardProject(
  input: CreateProjectInput,
  apiKey: string,
): Promise<VizardCreateResponse> {
  const body: Record<string, unknown> = {
    lang: input.lang || 'auto',
    preferLength: input.preferLength && input.preferLength.length > 0 ? input.preferLength : [0],
    videoUrl: input.videoUrl,
    videoType: input.videoType,
  };
  if (input.videoType === 1) {
    body.ext = input.ext || detectExt(input.videoUrl) || 'mp4';
  }

  const res = await fetch(`${VIZARD_BASE}/project/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'VIZARDAI_API_KEY': apiKey,
    },
    body: JSON.stringify(body),
  });

  // Vizard returns JSON on both success and error. Parse leniently.
  let parsed: VizardCreateResponse;
  try {
    parsed = (await res.json()) as VizardCreateResponse;
  } catch {
    parsed = { code: res.status, errMsg: `HTTP ${res.status}` };
  }
  return parsed;
}

/** GET /project/query/{projectId} — returns clips when code === 2000. */
export async function queryVizardProject(
  projectId: string,
  apiKey: string,
): Promise<VizardQueryResponse> {
  const res = await fetch(`${VIZARD_BASE}/project/query/${encodeURIComponent(projectId)}`, {
    method: 'GET',
    headers: { 'VIZARDAI_API_KEY': apiKey },
  });

  let parsed: VizardQueryResponse;
  try {
    parsed = (await res.json()) as VizardQueryResponse;
  } catch {
    parsed = { code: res.status, errMsg: `HTTP ${res.status}` };
  }
  return parsed;
}
