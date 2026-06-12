<!-- Synthesized 2026-06-11 from frame-by-frame decode of all 14 OG MG instances (8 channel_b_proof + 6 saturation_callout, clips/mg-beats/) by a 17-agent workflow; companion file: channel-b-saturation-spec.md -->

# GAP ANALYSIS — channel_b_proof & saturation_callout (reference spec vs job-154 vs codebase)

## 0. What the code actually loads/renders today (baseline)

- Channel B block: `lib/content-gen/listicle-builder.ts:1241-1320`. Calls `findSimilarChannels` (`similar-channels.ts:70-141`), then `loadChannel(b.channel_id)` (`listicle-builder.ts:31-104` — name, handle, subs, video_count, `channel_created_at`/`first_upload_at`→joined_date, total_views, top video) and `loadNicheVars(b.channel_id)` (`niche-vars.ts:254-321` — only `age_phrase` is consumed for B, at `listicle-builder.ts:1265`). `loadChannel` triggers `refreshChannelStats` (`refresh-channel-stats.ts`) which hits YT API `channels?part=statistics` ONLY — subs/videos/views, **no snippet (no publishedAt/country/avatar)**.
- Saturation block: `listicle-builder.ts:1323-1350`. Takes 2 ids from `montagePool` (10 available, `similar-channels.ts:135-139`), renders raw `channel_page` captures full-frame with `ken_burns: 'zoom_in_8pct'`. No `loadChannel`/stats refresh for these channels (OK — numbers are visual-only), no text cards, no third page.
- Capture tool (`yt-capture.ts:48`): kinds = `channel_page | about_page | videos_tab | watch_page` only. Extracts bboxes (subs/videos/views/joined/channel_name/avatar + per-card `video_card_N/video_thumb_N/video_views_N/video_title_N` + `__meta.views_texts` strings, `yt-capture.ts:875-1094`). `scroll_record` exists (default for videos_tab, `yt-capture.ts:412`) but scrolls the whole page with ease-in-out cubic (`yt-capture.ts:1127-1150`). No sort-chip control in `urlFor` (`yt-capture.ts:385-400`), no search-results kind.
- Render-side croppers all exist (`video-compose.ts:231-341` → `yt-compose-mg.ts`): `about_panel` (49), `channel_chip` (215), `channel_page_full` (299, strips sidebar + rounds card on canvas), `thumbnail_rapid_fire` (378), `videos_grid` pano (439). **None of these crops are applied to the channel_b_page or saturation slots** — `listicle-builder.ts:1288` and `:1343` ship the raw 1440x900 screenshot (masthead + sidebar visible), which is why job-154 violates the 14/14 card-on-canvas invariant.

---

## 1. DATAPOINT GAPS

| # | Reference datapoint | Status today | Source | New call? |
|---|---|---|---|---|
| D1 | **Hard numbers must be visual-only** (invariant 11: 0/8 speak subs, 0/8 exact views) | VIOLATED: `outputLine` speaks subs + video count aloud (`listicle-builder.ts:1268-1271`, "it already has ten thousand subscribers with just 24 videos") | No fetch needed — rewrite narration to category claims ("and it's already performing extremely well") | NO — narration change only |
| D2 | Channel-B join date consistent with spoken age (the job-154 "Joined Feb 16, 2013" vs "five months ago" contradiction) | `age_phrase` uses `first_upload_at ?? channel_created_at` (`niche-vars.ts:272`, `:110-118`) but the About screenshot shows account-creation date; KNN-found channels often have stale/NULL `first_upload_at` (it derives from sighted videos only) | (a) Guard: if `channel_created_at` and `first_upload_at` differ >60d, suppress the age fragment or don't show the Joined row; (b) refresh real join date via YT API `channels.list part=snippet` (publishedAt, country, avatar) — currently only `part=statistics` is requested (`refresh-channel-stats.ts` URL builder) | YES — EXISTS-needs-params (add `snippet` to the same API call) |
| D3 | First-upload date for channel B (true "started posting") | Unreliable for arbitrary KNN channels | Cheapest truth: capture `videos_tab` sorted **Oldest** and read the last card's age text, or YT API `playlistItems` on the uploads playlist (1 unit) | YES — NEW-small (either path) |
| D4 | Per-video view counts / ages / durations / title-template (shown 8/8) | Free in the live screenshot; `views_texts` extractor exists (`yt-capture.ts:1071-1087`) but no `videos_tab` capture is requested for channel B | `yt_capture videos_tab` for B | YES — EXISTS-unused |
| D5 | Optional spoken performance claim "most popular video has more than {ROUNDED-DOWN N} views" (1/8) | Data exists: `top_video_view_count` already loaded in `loadChannel` (`listicle-builder.ts:75-102`) but unused for B; `humanizeNumber` rounds nearest, not down | DB (niche_spy_videos) — add round-DOWN formatter | NO new fetch — EXISTS-unused |
| D6 | Popular-sort proof view (3/8) | Capture always lands Latest (`urlFor` → `/videos`) | Needs chip-click or `?sort=p` before screenshot | YES — NEW-build small (`sort` param on yt_capture) |
| D7 | About-panel extras: country, total views, join date close-up (CB7) | `about_page` capture has them; stats slot shows them; country placeholder "United States" is hardcoded in `swapChannelProof` (`listicle-builder.ts:692`) | Real country from `channels.list part=snippet` (same call as D2) | EXISTS-needs-params |
| D8 | Saturation cluster: 3 sibling channel pages (Form A) | Only 2 used (`slice(0, 2)`, `listicle-builder.ts:1324`); `montagePool` already holds 10 | similar-channels output | NO — EXISTS-unused |
| D9 | Cluster cadence claim ("upload every single day", 1/6) | `uploads_per_month` computed in `niche-vars.ts:317` — never used in saturation narration; not computed for sibling channels | DB; for siblings compute from niche_spy_videos posted_at density | NO new fetch — EXISTS-unused (logic) |
| D10 | Multi-channel search results (SC4: thumb/title/views/age/channel/desc per result) | Nothing — no `search_results` capture kind | New ScreenKind + bbox rules; query string derivable from existing data (niche label or shared title-template n-gram from `niche_spy_videos.title` across montagePool channels) | YES — NEW-build |
| D11 | Contrast/negative-example grid (2/6: "easy niche" channels with weak views) | Nothing | DB query: low-median-view channels in a different niche (niche_spy_channels × channel_analysis.niche) + existing `videos_tab` capture | YES — NEW selection query; capture EXISTS |
| D12 | Competition level / gauge / crowd / analytics-timeline / calendar (1/6 each) | Nothing; `saturationCount` is computed (`similar-channels.ts:116`) but never surfaced | saturationCount can drive a LOW/HIGH gauge directly; analytics + calendar are static assets | YES — NEW-build assets (data already exists for the gauge) |
| D13 | Stale subs for montage ranking | `findSimilarChannels` reads DB subs without refresh (`similar-channels.ts:124-126`) | Batch `channels.list` (50 ids/unit) | OPTIONAL — EXISTS-needs-params |

---

## 2. VISUAL GAPS (reference frequency → what's missing → render path)

| # | Reference behavior | Job-154 behavior | Fix path |
|---|---|---|---|
| V1 | **Card-on-canvas framing, 14/14** (page floats as rounded card, no masthead/sidebar/chrome) | Full-frame page incl. masthead + sidebar on all 3 page slots | `crop_target: 'channel_page_full'` already does exactly this (`yt-compose-mg.ts:299`, used by hero at `listicle-builder.ts:594`) — just absent at `:1288` and `:1343`. **EXISTS-unused** |
| V2 | **Hard cuts + static dead-holds, 14/14; programmatic zoom 1/14** | Continuous Ken Burns push-in on all 3 page slots | Set `ken_burns: 'none'`. **EXISTS-needs-params** |
| V3 | Header-chip → full-page progressive disclosure (4/8; chip favored when headline stat is low-subs/young — our exact framing) | Cold full page only | `crop_target: 'channel_chip'` (`video-compose.ts:292`, `yt-compose-mg.ts:215`). **EXISTS-unused** |
| V4 | Proof amplifier (5/8): cut-to-tighter-crop of grid row / lone video card / about close-up / scrolling grid | Only the about stats slot | Grid row & lone card: `thumbnail_rapid_fire:N` + `videos_grid` croppers **EXISTS-unused** for B; scroll: `scroll_record` **EXISTS but off-spec** (ease-in-out full-page scroll vs constant-velocity inside a fixed card viewport — `yt-capture.ts:1127-1150` needs linear easing + composer-side card mask = NEW-small) |
| V5 | Verdict text-card chain echoing narration, replace-not-stack (4/8) | None after the stats slot | `makeFramingSlot` text cards + `text_card_reveal` **EXIST** — builder just doesn't emit them. **EXISTS-unused** |
| V6 | Silent dwell 0.6–1.05s on the numbers after narration ends (CB1, CB3) | `hold_s: '{{narr.duration_s}}'` exactly — zero dwell | hold_s arithmetic or post-pass pad on the stats slot. **EXISTS-needs-params** (small compose change) |
| V7 | Saturation Form A rhythm: 3 pages at ~0.6s each — the rapidity IS the "many channels" claim — then 2 dark text cards (one italic word-build) | 2 pages at 2.5–3.0s each, no text cards | Builder restructure: narration master + fixed short holds (audio_slice machinery already supports decoupling); text cards exist; italic emphasis = NEW-small in card renderer. **EXISTS-needs-params + NEW-small** |
| V8 | Drawn annotations **0/14** — emphasis via crop isolation / dwell / sort-selection only | Animated olive marker highlight on "10.4K subscribers" (also tone-on-tone ~1.6:1 contrast) | Either drop the highlight for these beats, or fix the blend to dark-on-yellow (`video-compose.ts:210-262`). Also un-highlighted "24 videos" despite narration stressing it — `highlight_row: 'videos'` is supported (`video-compose.ts:262`) but only if you keep highlights at all |
| V9 | Screenshot hygiene: real-YT metadata format (`66K views • 6 days ago`) | Saturation pages render `11K 12d ago` (compact lockup variant, no "views", no bullet) | Capture-time DOM normalization pass (page.evaluate text rewrite before screenshot) or wider viewport for `channel_page` like videos_tab's 1700px (`yt-capture.ts:29-31`). **NEW-build small** |
| V10 | About-panel fidelity | Missing row icons (empty gutter), clipped glyph sliver ~25px above card bottom | `composeAboutPanelMG` crop geometry (`yt-compose-mg.ts:49-123`): extend left edge to include the icon gutter, trim bottom before the next row. **EXISTS-needs-fix** |
| V11 | Text cards: centered, baseline ~48–55% height; instant pop-on 12/14, word-build only 2/14 | Always word-builds (`REVEAL_MIN_WORDS=4`, `listicle-builder.ts:882`, `:940-948`), left-anchored x~270, awkward "five / months" split | Make word-reveal probabilistic/exceptional; center the line; wrap at prosodic groups. **EXISTS-needs-fix** |
| V12 | Meme/reaction card tails (2/8 CB) + memes/infographics in saturation Forms C/D/E (typing memes, gauge, calendar, emoji crowd, chess) | None; no asset library or tool | **NEW-build** (asset library + a `footage_card`/`infographic_card` composition in image_gen, `tools.ts:162`) |
| V13 | Beat-boundary bleed (~9/14) — sentences/cuts cross beats | Mostly OK (`applyContinuousNarration` gives one continuous read per niche group) but every cut still lands on a sentence boundary | Allow narration spans to straddle slot joins (slice boundaries mid-sentence). Low priority |
| BUG | (not in spec) expected `niche_1_transition` absent from render | Builder DOES emit it (`listicle-builder.ts:1373-1388`) after saturation — producer or compose appears to drop the silent 0.5s slot; investigate separately | — |

---

## 3. NEW TOOL CALLS REQUIRED (concrete, prioritized)

**P0 — close the invariant violations (hours, no new tools)**
1. `crop_target: 'channel_page_full'` + `ken_burns: 'none'` on `niche_*_channel_b_page` and both saturation slots — `listicle-builder.ts:1288`, `:1343`. **EXISTS-unused**
2. Rewrite `outputLine` to category claims; digits stay on screen (`listicle-builder.ts:1268-1271`). Optional rounded-DOWN views clause from already-loaded `top_video_view_count`. **EXISTS-unused data**
3. Joined-date contradiction guard: compare `channel_created_at` vs `first_upload_at` (both already in `loadChannel`); on conflict, drop the age fragment or skip the about-stats shot in favor of a grid amplifier. **EXISTS-needs-params (logic)**
4. `channels.list part=snippet,statistics` in `refresh-channel-stats.ts` → real publishedAt + country (also kills the hardcoded "United States" at `listicle-builder.ts:692`). **EXISTS-needs-params**
5. Stats-slot silent dwell: `hold_s = narr.duration_s + 0.8`. **EXISTS-needs-params**
6. Highlight fix or removal (contrast blend in `video-compose.ts:210-262`); if kept, add the `videos` row when narration stresses video count. **EXISTS-needs-fix**

**P1 — reference shot grammar (1–2 days)**
7. `yt_capture channel_chip` entry shot before the B page (chip→page funnel). **EXISTS-unused**
8. `yt_capture videos_tab` (static) for channel B → grid amplifier via `videos_grid` pano and/or lone-card payoff via `thumbnail_rapid_fire:N`; `views_texts` feeds the optional spoken claim. **EXISTS-unused**
9. Saturation Form A restructure: 3 montagePool pages × ~0.6s + 2 dark verdict text cards. **EXISTS-needs-params (builder)**
10. `composeAboutPanelMG` geometry fixes (icon gutter, bottom sliver). **EXISTS-needs-fix**
11. Metadata-format normalization injected at capture time (`yt-capture.ts` pre-screenshot evaluate). **NEW-build small**
12. Verdict/fragment card centering + pop-on default. **EXISTS-needs-fix**

**P2 — new capture capabilities**
13. `sort: 'popular' | 'oldest'` param on yt_capture (click chip before extract+screenshot; `urlFor`/`runCapture` in `yt-capture.ts`). Powers Popular-sort proof (3/8) and the Oldest-page first-upload readout (D3). **NEW-build small**
14. `search_results` ScreenKind (`yt-capture.ts:48` + BBOX_RULES + per-result card extraction; query from shared title-template n-gram). Powers SC4 form. **NEW-build medium**
15. Constant-velocity inner-card scroll: linear easing in scroll_record + composer that masks the webm inside a rounded card viewport. **NEW-build medium**
16. Contrast-grid selection query (weak "easy niche" channels) + existing videos_tab capture, for the moat form (SC2/SC6). **NEW query, capture exists**
17. Infographic/meme asset library + `infographic_card`/`footage_card` compositions (LOW/HIGH gauge driven by existing `saturationCount`, calendar flip, emoji crowd, typing memes). **NEW-build large**
18. Optional: batch stats refresh for montagePool ranking; second channel-B beat from `sim.channels[1]` (multi-B, attested in niche 2). **EXISTS-unused**

## 4. PRIORITY ORDER (fidelity gained per unit work)

1. **P0-1 (crop+no-zoom)** — one-line edits fixing two 14/14 invariants (card-on-canvas, static holds) across 3 of 5 slots.
2. **P0-2 (stop speaking digits)** — fixes the single deepest invariant (numbers on screen, claims in voice).
3. **P0-3/4 (joined-date guard + snippet refresh)** — kills the top-ranked story contradiction in job-154.
4. **P0-5/6 (dwell + highlight fix)** — the eye-pointing mechanic the reference uses instead of annotations.
5. **P1-9 (Form A 3-page rhythm + text cards)** — makes "many channels" actually read as many; data already in montagePool.
6. **P1-7/8 (chip funnel + grid amplifier)** — the 4/8 and 5/8 optional shots that make long-form B beats.
7. **P1-10/11/12** — fidelity polish (about panel, metadata text, card typography).
8. **P2-13/14** — sort control then search_results (unlocks 2 more attested saturation/proof forms).
9. **P2-15/16/17** — scroll cards, contrast grids, meme/infographic library (unlocks Forms C/D/E; biggest build, lowest per-unit payoff until the above land).
