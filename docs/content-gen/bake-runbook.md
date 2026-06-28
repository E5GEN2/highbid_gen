# Content-Gen Bake Runbook (Fresh Group → Rendered Listicle)

> Authoritative, code-grounded, end-to-end. Self-sufficient for an operator with zero prior context.
> All paths absolute under `/Users/rofe/Desktop/lab/hbgen/highbid_gen/`.
> Style anchor: the Money Groot faceless-niche listicle grammar (OG reference yt `qLeWyKufd8M`). See `docs/content-gen/beats-reference.md` + `worked-example-mg-reverse-engineered.md` for the canonical beat sequence/narration the render reproduces.
> Last verified against code + the approved render (job 124): 2026-06-24.

---

## 0. Mental model

A "bake" turns a frozen group of YouTube channel IDs into one rendered listicle MP4, then marks the group consumed.

```
PREP (prod DB writes)        SYNC (prod→local)         RENDER (local)            POST
1 analyze  (transcribe)      pull-local.mts            render.mts from-channels  mark-complete (use-group)
2 meta-extract (cga)         (copies prep tables       → builder → writer        thumbnail (auto, logos gem)
3 rpm (force AFTER cga)       + keys + assets)          → producer → mp4          description (MANUAL)
4 recipe-showcase                                       retry: from-job <id>
```

- **Prep endpoints** run against **PROD** and write the `content_gen_*` tables the render later consumes.
- **Render** runs **locally** against `hbgen_local`, but keeps **prod reachable** for embeddings (channel_b / saturation).
- Order is a **hard invariant**: `1 → 2 → {3 ∥ 4}`. Step 3 (RPM) has a stickiness trap (see §3).

---

## 1. Prerequisites

- `.env.local` at repo root must contain at minimum:
  - `DATABASE_URL=` → Railway main DB (prod). Used for embeddings even on local render.
  - `VECTOR_DB_URL=` → pgvector DB (prod) for KNN similar-channel search.
- Node + `tsx` available. Always run render/pull with the project tsconfig:
  `npx tsx --tsconfig ./tsconfig.json scripts/local/<script>.mts …`
- **Auth for prep endpoints**: every `/api/admin/content-gen/*` POST/GET requires `isAdmin(req)` (else 403 "Admin token required"). Use ONE of:
  - cookie `admin_token` (base64 `admin:…:rofe_admin_secret`), or
  - header `Authorization: Bearer hba_…` (Claude admin token).
  - Hit the **prod base URL** (rofe.ai admin API) — prep writes prod tables.
- ElevenLabs key must exist in prod `admin_config` under key `elevenlabs_api_key` (voice.ts:76; render throws "elevenlabs_api_key not configured" if missing). `pull-local` copies it into local `admin_config`.

---

## 2. Choose the group

Pick the frozen channel ID set. Two sources:

- **From a pinned group** (preferred): `GET /api/admin/content-gen/drafts` returns mixed drafts with `group_key` IDs. The pinned snapshot is the stable, frozen set (pinned-groups.ts).
- **Ad-hoc**: any list of `UC…` channel IDs.

Cap is **16 channels** (listicle-builder.ts:1279). Typical group = 10.

Record the channel CSV, e.g. `UCaaa,UCbbb,UCccc,…`.

---

## 3. PREP — four endpoints, in order (PROD)

All four are `POST` with JSON. Endpoints:
- `/api/admin/content-gen/analyze`
- `/api/admin/content-gen/meta-extract`
- `/api/admin/content-gen/rpm`
- `/api/admin/content-gen/recipe-showcase`

### 3.1 analyze (transcribe) — writes `video_analysis_jobs`
```
POST /api/admin/content-gen/analyze
{ "videoIds": [<top 2-3 video ids per channel>], "concurrentStarts": 5, "skipAnalysed": true, "maxDurationMinutes": 30 }
```
- Creates one `video_analysis_jobs` row per video (status='pending'), fires first 5 workers, transcribes via yt-dlp+ffmpeg+Gemini into `timeline_jsonb` (SAY/SEE/HEAR segments).
- **Poll**: `GET /api/admin/content-gen/analyze?videoIds=1,2,3` — wait until every job `status='done'`. ~3–5 min/video; plan 5–15 min queue.
- Gotchas: videos with no `url` in `niche_spy_videos` silently skip; per-clip Gemini failure → `status='error'` (not auto-retried).
- **Must fully complete before step 3.2.**

### 3.2 meta-extract (cga / channel analysis) — writes `content_gen_channel_analysis`
```
POST /api/admin/content-gen/meta-extract
{ "videoIds": [<same ids>], "force": false }
```
- Dedupes to one per channel, calls `analyzeChannelComplete(channelId)` (lib/content-gen/unified-analyzer.ts) — single Gemini call over top titles+thumbnails + 1–3 transcripts. Use this, NOT the superseded `labelChannelNiche`/`niche-labeler`.
- Writes `niche_label, recipe_formula, language, is_faceless, production_format, voice_type, …, analyzer_version=2`.
- ANALYZER_VERSION=2: channels with a current-version analysis are skipped unless `force:true`.
- Channels with no DONE transcript land in `notReady` (silently un-analyzed) — confirm step 3.1 finished.
- Language note: non-English / non-Latin-script channels are gated at discovery (discovery.ts:286-301). A no-speech visual niche (lang=none) is still a valid faceless channel — keep it; it degrades to catalog-only inference.

### 3.3 rpm (STICKY — run AFTER 3.2, force) — writes `content_gen_channel_rpm`
```
POST /api/admin/content-gen/rpm
{ "channelIds": ["UCaaa","UCbbb",…], "force": true }
```
- `getOrEstimateChannelRpm` reads `content_gen_channel_analysis.niche_label` + `language` to ground the Gemini estimate; watches top video first 3 min if possible (`grounded_on='video'` else `'context'`).
- **TRAP**: RPM cache is keyed on channel_id with NO auto-invalidation. If RPM ran before meta-extract, niche = `'(unknown niche)'` (rpm.ts:236) and stays stale. **Always run RPM AFTER meta-extract with `force:true`.** If you ever re-run meta-extract, you MUST re-run RPM with `force:true`.

### 3.4 recipe-showcase — writes `content_gen_recipe_showcase`
```
POST /api/admin/content-gen/recipe-showcase
{ "channelIds": ["UCaaa",…], "force": false }
```
- Needs transcripts (step 3.1). Reads `niche_label`+`recipe_formula` from meta-extract for grounding; generates 4–6 paired beats (narration + clip start/end snapped to real transcript segments) into `beats_jsonb`. Throws "no usable transcripts" if step 3.1 incomplete. Missing meta-extract → generic beats (niche/recipe = unknown).

### Prep dependency / regeneration rules
| Re-run | Then must re-run | Why |
|---|---|---|
| meta-extract | rpm (force:true) | RPM cache stale on niche_label change (no auto-invalidate) |
| analyze (new videos) | recipe-showcase (force:true) optional | richer transcript corpus |

---

## 4. SYNC — prod → local (`pull-local.mts`)

**MANDATORY before any local render** — `hbgen_local` must hold the prep tables, assets, AND a fresh key/proxy pool. Skipping this → render fails on empty local tables, or 429-churns on a stale key pool. Re-pull (or targeted-copy `xgodo_api_keys` + `xgodo_proxy_health`) if it's been hours since the last pull.

```
npx tsx --tsconfig ./tsconfig.json scripts/local/pull-local.mts UCaaa,UCbbb,UCccc,…
```
(Channel list is positional/CSV. Besides the group's channels, it also drags in **every video referenced by `video_analysis_jobs`** — the shared 300+ transcript corpus — so local `niche_spy_videos` is far larger than 10 channels' worth.)
What it copies into `hbgen_local`:
- **FULL_TABLES** (copied whole): `admin_config` (incl. elevenlabs key), `content_gen_channel_analysis`, `channel_analysis`, `content_gen_yt_screens`, `content_gen_voice_assets`, `content_gen_sfx_assets`, `content_gen_tool_cache`, `content_gen_tool_version_overrides`, `content_gen_producer_jobs`, `content_gen_producer_gems`, `content_gen_scripts`, **`xgodo_api_keys`**, **`xgodo_proxy_health`**, `niche_spy_channels`. ⚠️ NOT all small: `channel_analysis` ≈ 50K rows, **`niche_spy_channels` ≈ 125K rows** — the latter takes ~6 min and can age out the proxy connection (~400s limit) mid-copy. The render only reads the GROUP's channels locally (loadChannel); channel_b/saturation read from prod (HB_RAILWAY_DB_URL, §5) — so set **`NSC_FILTER=1`** to copy only the group's `niche_spy_channels` rows (10, instant) instead of all 125K. Fastest-path recovery if a sync drops: `NSC_FILTER=1 ONLY_TABLES=niche_spy_channels,niche_spy_videos,content_gen_recipe_showcase,content_gen_channel_rpm,content_gen_rpm_cache pull-local.mts <CSV>` (resumes just the missing tables on a fresh connection).
- **`niche_spy_videos`**: the group's channels PLUS every video referenced by `video_analysis_jobs` (the full 300+ transcript corpus) — so local table is much larger than 10 channels.
- **ANALYSIS_TABLES**: `video_analysis_jobs`, `video_analysis_clips`, `content_gen_recipe_showcase`, `content_gen_channel_rpm`, `content_gen_rpm_cache`, deep_analysis_*.
- Then asset files + path rewrite. Prints a sanity line confirming `elevenlabs present` + draft channels present.

**Key facts (corrects common misconceptions):**
- **Embedding columns are now excluded BY NAME** (`copyTable` skips any `/embedding/i` column, pull-local.mts:104). ⚠️ CORRECTION (2026-06-26): the old claim that embedding columns "don't exist in the local schema" was FALSE — `niche_spy_videos` locally HAS `title_embedding`, `title_embedding_v2`, `thumbnail_embedding_v2`, `combined_embedding_v2` (each ~12KB/row). With the old plain `srcCols ∩ localCols` intersection they WERE copied, so a 314-row group pushed ~15MB of vectors over the flaky Railway proxy and **hung forever** (pull-local has no per-query timeout). KNN/embeddings are read from prod at render — never needed locally — so they're now always dropped. If a pull ever hangs on a big table again, suspect a heavy column being copied (probe with `pg_column_size`).
- **Key/proxy freshness is part of pull-local**: `xgodo_api_keys` + `xgodo_proxy_health` are in FULL_TABLES, so a fresh pull refreshes the key pool. A "good" key = `status='active'` AND (`banned_until IS NULL OR banned_until < NOW()`). If you render hours after the last pull, **re-pull (or targeted-copy those 2 tables)** to avoid a stale poison pool (e.g. local 348 vs prod 742 good keys → 429 churn). Optionally refresh prod first: `POST /api/admin/tools/proxy-health` and `/api/admin/tools/yt-keys-health`.
- **Embeddings stay on prod**: local has no embedding table. Render keeps prod reachable for channel_b/saturation (see §5).

---

## 5. RENDER — `render.mts` (local)

### Build a fresh listicle
```
npx tsx --tsconfig ./tsconfig.json scripts/local/render.mts \
  from-channels UCaaa,UCbbb,UCccc,… <beat_id> --local --labels
```
- **`from-channels <CSV> <beat_id>`** invokes the shared `buildListicleScript` (same code as the prod route).
- **`beat_id`** (mandatory 2nd positional, applied to EVERY channel) — selects only the per-niche **stub** seed (listicle-builder.ts `stubNarration`, ~143–172). **The builder/script-writer injects intro_card, niche_name_card, and ALL the rich conditional beats (channel_page, emphasis, proof, top_views_rapid, top_videos_pano, channel_age, money-math, recipe_demo, channel_b, saturation, transitions, cta) ON TOP of the stub regardless of which beat_id you pass.** So the beat_id is a small seed, not the grammar.
  - **`niche_segment_3` — USE THIS for production.** Stub = 3 beats (channel_proof_1, channel_proof_2, top_video_callout). The builder enriches it to the full grammar. ✅ EMPIRICALLY VALIDATED: the user-approved render (job 124, 247 slots, all 23 beat kinds, NO concept_tag) used `niche_segment_3`.
  - **`niche_segment_full` — DO NOT use for production.** Stub = 6 beats and it ADDS a `concept_tag` chalkboard whose hardcoded text is literally `"consistency"` — i.e. it re-injects the exact word we deliberately removed from the saturation wording. It does NOT make the video "richer" (the builder already adds intro/niche_name/etc.); it only bolts on that unwanted concept_tag. (A 2026-06 doc-audit agent mis-recommended `full` as "production" by reading stub size statically — verified false against job 124.)
  - Single-beat ids (`channel_proof_1`, `top_video_callout`, …) emit just that one beat. A beat_id with no stub case → `stubNarration` returns `[]` → the channel **fails to author** (listicle-builder.ts:1367).
- **`--local`**: swaps `DATABASE_URL` → `postgresql://localhost:5432/hbgen_local` and sets `HB_RAILWAY_DB_URL` := original Railway URL. Embeddings (`VECTOR_DB_URL` + `HB_RAILWAY_DB_URL`) stay on **prod** — required for channel_b/saturation. If prod unreachable, those beats silently drop; render still succeeds.
- **`--labels`** (HB_DEBUG_LABELS=1): stamps `slot_id` top-right of every frame. **Use for review** — verify by label tag, not by timeline (computed times drift on late beats; labels are ground truth).
- Voice is **ElevenLabs by default** (no flag) — `DEFAULT_VOICE_ID='onwK4e9ZLuTAKqWW03F9'`, `DEFAULT_MODEL='eleven_multilingual_v2'`. Tempo via `HB_NARRATION_TEMPO` (default 1.22; `=1.0` disables).

### Other render flags
- `--logos UCx,UCy,…` — override intro-montage logo channels.
- `--summary-only` — print the beat plan (which conditional beats fire per channel) and **skip the render**. Run this first to sanity-check gating.
- Beat toggles: `--rapid|--callout|--pano|--age|--video-box|--channel-b|--saturation|--money|--recipe|--emphasis on|off` (default `auto` = gate decides).
- Thresholds: `--callout-mult N` (default 8× median), `--pano-floor N` (default 50K), `--age-max N` (default 4 mo), `--video-box-max N` (default 12).
- `--teleprompter` (HB_TELEPROMPTER=1): narration overlay → `_latest_teleprompter.mp4`.
- `--split-niches` (HB_SPLIT_NICHES=1): per-channel clips → `clips/teleprompter/`.
- `--narration-manifest <json>`: rewrite each slot's `narr` gem to `audio_slice` from your own recording → `_latest_myvoice.mp4` (in-memory only, no DB write).
- `--max-slots N` / `--drop-transitions` / `--no-dwell`: quick-test / face-cam helpers.

### What the builder does (per channel)
loadChannel → load niche-vars (recipe/rpm/age/views) → emit stub narration (beat_id) → run Gemini script-writer (3× retry on transient) → post-transforms (forceProofKind, swapMostPopularCallout, injectCropTargets) → gate conditional beats (callout ≥8× median, pano p10≥50K, age≤4mo, video_count≤12+strong, money_math if top≥1000 views, recipe if recipe_beats exist, channel_b/saturation via embeddings) → record beat plan → order/inject slots → continuous narration (one ElevenLabs master TTS per niche, sliced per slot via `audio_slice`).

### Resilience (no manual action; understand the behavior)
- Gemini writer: up to 24 attempts, fresh healthy AI key + random healthy proxy each try; 429 → cool key 5 min + rotate; 401/403 → invalidate key.
- `withRetry` (retry.ts): 3 attempts, transient regex (429/RESOURCE_EXHAUSTED/timeout/5xx/ECONNRESET/YT_PAGE_UNAVAILABLE) on writer, similar-channels, captures.
- channel_b/saturation: per-candidate min-stats gate (subs≥5K OR views≥500K&vids≥3), relationship verify, capture-feasibility (videos_tab_popular, ≥4 cards; dead/404 → skip; transient → keep, compose retries).
- Saturation wording is **ceiling-based** (top-3 Popular-grid median), never a consistency claim. A spoken number about a captured grid must derive from THAT capture.
- `HB_SLOT_CACHE=1` (opt-in): per-slot checkpoint cache, key = `SLOT_COMPOSE_VERSION` ('sc2') + compose config + asset paths. **Bump `SLOT_COMPOSE_VERSION` after ANY change to `buildSlotClip` or the composers**, else stale clips render. A 254-slot re-render reuses in seconds.

### Output
Final MP4 copied to `clips/_latest_labeled.mp4` (with `--labels`), `_latest_teleprompter.mp4`, `_latest_myvoice.mp4`, or `_latest.mp4` (clean). Absolute path is printed.

### Retry / re-render (no rebuild)
```
npx tsx --tsconfig ./tsconfig.json scripts/local/render.mts from-job <jobId> --local --labels
```
- Pulls baked `script_jsonb` from `content_gen_producer_jobs`, **skips builder + Gemini writer**, re-runs gems (cached gems reused) + recomposes. Use after transient gem failures, for frame review, or with `--narration-manifest`.

---

## 6. VERIFY

1. Run with `--labels`; inspect `clips/_latest_labeled.mp4`. Reference beats by their on-frame `slot_id` (timeline drifts; labels are truth).
2. Check the printed beat plan (or `--summary-only`) — confirm expected conditional beats fired per channel.
3. Cross-check against `docs/content-gen/beats-reference.md` (current production sequence) and `worked-example-mg-reverse-engineered.md` (MG narration/visual reference).
4. Audio sanity: continuous VO, no missing-key crash, no silent gaps beyond design (music bed is intentionally null — OG MG has none).
5. If a beat is wrong, fix data (re-prep that channel) or re-render with a beat toggle/threshold override; then `from-job` to re-render fast.

---

## 7. POST-RENDER

### 7.1 Thumbnail — AUTOMATED
If the script includes a `logos_montage` gem, the thumbnail is produced during the render: `composeChannelLogosMontageMG` (yt-compose-mg.ts:778) builds a 1920×1080, 2×5 channel-avatar grid PNG (`runLogosMontage`, producer-tools.ts:206). Avatar fetch failures render that cell empty (non-fatal). No separate call needed.

### 7.2 Mark-complete — consume the group
```
POST /api/admin/content-gen/use-group
{ "pinnedGroupId": "<group_key>", "note": "optional" }
```
- Preferred path: server resolves the pin's **frozen** channel set via `consumePinnedGroup` (immune to UI drift — the swap-trap), flips pin `status='consumed'`, then `markGroupUsed` inserts each channel into `content_gen_used_channels` (excluded from all future discovery) and invalidates the seed cache.
- Back-compat path: `{ draftId, draftTitle, channelIds:[…], note }`.
- If a channel was **swapped in at render time** (not in the frozen pin), mark it separately so it's excluded.
- Un-consume (mistake recovery): `DELETE /api/admin/content-gen/use-group { "pinnedGroupId": "<key>" }` (or `{channelIds:[…]}`) → pin back to `active`, channels removed from used set.

### 7.3 Description — MANUAL (no automation)
There is **no description generator in the codebase** — no function, no endpoint, no `video_description` DB column; producer.ts ends at `final_video_url`. Write/paste the YouTube description by hand at upload time. (Title/thumbnail-text specs are intentionally deferred.)

---

## 8. Failure quick-reference

| Symptom | Cause | Action |
|---|---|---|
| RPM says "(unknown niche)" | RPM ran before meta-extract, or meta-extract re-run | re-run rpm with force:true after meta-extract |
| recipe-showcase throws "no usable transcripts" | step 3.1 not done | finish analyze; poll until allDone |
| Channel silently un-analyzed | no DONE transcript (in notReady) | re-run analyze for its videos |
| Render: "elevenlabs_api_key not configured" | local admin_config missing key | re-run pull-local (copies admin_config) |
| 429 churn during render | stale local key pool | re-pull (refreshes xgodo_api_keys/proxy_health); good key = active & not banned |
| channel_b / saturation beats absent | prod/VECTOR_DB unreachable, or <0.78 sim / <4 grid cards | ensure prod reachable; otherwise expected drop (render still ok) |
| Whole channel fails to author | beat_id has no stub | use niche_segment_3 or niche_segment_full |
| Stale cached clip after composer change | SLOT_COMPOSE_VERSION not bumped | bump 'sc2' → next value |
| Stale clip after a NARRATION/script patch (re-narrated slots render old audio/visuals) | HB_SLOT_CACHE keys on asset PATH, not content; re-narration reuses the same audio path | re-render the patched job CLEAN **without** `HB_SLOT_CACHE` (full fresh compose). Symptom: render log says "244/245 reused" when you changed a slot's narration. |
| Proof VO number ≠ about-modal screenshot ("10.7M views" over a 7.36M modal, "10 videos" over 11) | `refreshChannelStats` hit YT-API 403 quota → fell back to the stale `niche_spy_channels` value, which is a per-video SUM that over-counts the official total | The YT Data API `statistics` IS what the modal shows; `MAX_RETRIES` is now 10 (refresh-channel-stats.ts) so it lands reliably. If a render still drifts, the Data API key pool was fully quota-depleted that moment — re-render later, or hand-patch the proof narration + re-render CLEAN. Do NOT try to read the number off the about-capture: its stats are in closed shadow DOM and the locator grabs wrong values ("45K views" = a video card). |
| VO STILL speaks the old number after a narration patch (script `narration` + audio_slice `text` look correct, but the audio is stale) | `applyContinuousNarration` NO-OPS when a slot's narr gem is already `tool:'audio_slice'` — its `eligible` filter only accepts `tool:'tts'`. The audio_slice `text` field is COSMETIC; the audio is the master mp3, which was never regenerated. | Before re-narrating, RESET each affected slot's narr gem to `{ id:'narr', tool:'tts', args:{ text, voice } }`, THEN call `applyContinuousNarration([slot])` (regenerates a fresh master + re-slices). **ALWAYS verify by TRANSCRIBING the audio** (ElevenLabs Scribe: `POST /v1/speech-to-text`, `model_id=scribe_v1`, header `xi-api-key`) and comparing the spoken number to the displayed/official — NEVER trust the script metadata. Then re-render CLEAN (no `HB_SLOT_CACHE`). |
| Re-render needed without re-author | transient gem failure | render.mts from-job <jobId> --local --labels |

---

## 9. File index
- Render entry: `scripts/local/render.mts`
- Prod→local sync: `scripts/local/pull-local.mts`
- Builder: `lib/content-gen/listicle-builder.ts` (stubNarration:143, beat_ids:152-172)
- Writer: `lib/content-gen/script-writer.ts` (24 attempts, key/proxy rotation)
- Producer: `lib/content-gen/producer.ts` (startJob/runJob), `lib/content-gen/producer-tools.ts`
- Voice/TTS: `lib/content-gen/voice.ts` (DEFAULT_VOICE_ID:37, tempo:53)
- Similar channels: `lib/content-gen/similar-channels.ts`; verify `lib/content-gen/channel-b-verify.ts`
- Slot cache: `lib/content-gen/video-compose.ts` (SLOT_COMPOSE_VERSION:1058)
- Retry: `lib/content-gen/retry.ts`
- Prep endpoints: `app/api/admin/content-gen/{analyze,meta-extract,rpm,recipe-showcase}/route.ts`
- Mark-complete: `app/api/admin/content-gen/use-group/route.ts`; `lib/content-gen/pinned-groups.ts`; `lib/content-gen/content-gen-seeds.ts`
- Thumbnail: `lib/content-gen/yt-compose-mg.ts` (composeChannelLogosMontageMG:778)
- Specs to verify against: `docs/content-gen/beats-reference.md`, `worked-example-mg-reverse-engineered.md`, `channel-b-saturation-spec.md`, `single-channel-beat-plan.md`
