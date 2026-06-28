# Render QA Protocol — the gate every render must pass

**Status:** living document. Created 2026-06-26 after a render shipped with multiple
classes of silent defects (black thumbnails, blank intro montages, garbled VO numbers,
mis-placed stat highlights) that were caught by the user one-by-one instead of by the system.

## The discipline (read this first)

A render is NOT done when it "renders successfully" (`gems N/N failed=0`). Gems report
success while emitting blank/black/garbled assets. A render is done when it **passes this gate**.

**The rule for every issue ever found in a render:**
1. **Root-cause** it in code/data (never "re-render and hope").
2. **Fix** it at the source.
3. **Add an automated CHECK** to the gate (`scripts/local/render-qa.mts`) that would have caught it.
4. **Document** it in the registry below.

If an issue recurs, its check is missing or wrong — that is the bug to fix, not just the symptom.
Never rely on eyeballing the final mp4.

**Cache corollary (learned 2026-06-26 the hard way — twice):** a fix to DB data that a gem
READS (avatars, captures, stats) is INVISIBLE to the render until you bust the dependent
`content_gen_tool_cache` rows. That cache is keyed by `tool:version:hash(gem args)`, NOT by the
underlying data — so syncing avatars then re-rendering still served the cached blank montage.
After ANY data fix: `DELETE FROM content_gen_tool_cache WHERE tool='<gem>'` (or bump the tool
version), then re-render. Robust fix: make the gem args carry the data (e.g. avatar URLs) so the
key is data-aware. And ALWAYS verify the actual rendered frame — not the gem output in isolation.

## Running the gate

```
npx tsx --tsconfig ./tsconfig.json scripts/local/render-qa.mts <jobId> <mp4>
```
Prints PASS/FAIL per check. **Do not deliver / post a render with any FAIL.**

## Pre-render checklist (data integrity)

- [ ] `channel_avatar` synced prod→local for every render channel (else blank intro montages — see #2)
- [ ] good xgodo keys + proxy health synced prod→local (stale local keys → 429 churn)
- [ ] prep complete: analyze → cga(meta) → rpm → recipe

## Issue registry (each row = a permanent check)

| # | Issue class | Symptom | Root cause | Fix (shipped) | Automated check | Status |
|---|---|---|---|---|---|---|
| 1 | Black thumbnails | grid thumbnails render solid black | capture thumbnail-waits all `.catch(proceed anyway)`; a slow i.ytimg.com proxy bakes black; `channel_page` never scrolled/forced-opacity like `videos_tab` | `yt-capture.ts`: channel_page scroll+opacity; `THUMBS_UNLOADED` gate throws transient → retry fresh proxy. **+2026-06-27: the gate scanned only IN-VIEW thumbnails (`r.bottom>0` is scroll-relative; the page is scrolled down to lazy-load at check-time), so mid-grid thumbs scrolled above the viewport top were never checked and baked black (Saving Savers `videos_tab` thumb_4/thumb_6 = solid black + only the duration badge). Gate now scans EVERY sized grid thumbnail, scroll-independent.** | `qa-thumbnails.mts` + `render-qa.mts` A — dark-pixel-fraction per `video_thumb_N` (mean/stddev fail: the white duration badge spikes stddev) | ✅ shipped |
| 2 | Blank intro montages | "Number N" reveal zooms into empty canvas | TWO layers: (a) `channel_avatar` NULL in local mirror (prod has them — sync gap), `logos_montage` skips null urls → blank; (b) that blank montage is then CACHED in `content_gen_tool_cache` by hash of args `{channelIds}` (not avatar data), so re-rendering after the sync STILL served it | sync `channel_avatar` prod→local **AND** `DELETE FROM content_gen_tool_cache WHERE tool='logos_montage'`; robust: builder passes avatar URLs into gem args so the key is data-aware | assert every `logos_montage` channelId has non-null `channel_avatar`; **verify the rendered intro frame is non-blank** (mean-luma > 80) | ✅ data+cache fixed; robust key + check: TODO |
| 3 | VO number mispronunciation | "141 thousand" → "hu-hundred and forty…"; "$1 RPM" → "one dol-dollar RPM"; "$6 RPM" → "6 doar" | EL's number normalizer verbalizes digit forms at synth time, non-deterministically → stutter. Numbers authored digit-form + sent to EL raw (voice.ts `cleanText=text.trim()`, no `apply_text_normalization`) | `verbalizeNumberPhrase()` (niche-vars) spells numbers as words AT AUTHORING: "N thousand/million"→words, "Number N"→"Number one", **"$N RPM"→"N dollar RPM"** (#4/#5). **SCOPE RULE (#1, learned 2026-06-27): apply to the NARRATION only, and ONLY where the on-screen card is a SEPARATE asset** (proof=capture, callout=image_gen, mm_rpm card="$N RPM"). DO NOT verbalize `text_card` beats where the card text IS the narration (mm_opener) — that flipped the card to "…point five million views"; those keep DIGITS (EL says "X million views" fine). NOT in voice.ts (desyncs caption char-offsets) | `render-qa.mts` C: Scribe transcript, flag adjacent-prefix / repeated-syllable stutters | ✅ shipped |
| 4 | VO ≠ displayed number | spoken count ≠ on-screen capture | spoken numbers must be derived from the DISPLAYED capture, never API/stored (page≠API is channel-specific) | numbers from capture (callout=spokenNumber, channel_b=spokenViewsFromCard, proof=floor of capture) | transcribe + compare each spoken number to its capture bbox | ✅ principle; check: automate |
| 5 | Highlight on wrong row | subscribers VO but yellow box on "Joined" row (Domain/niche_3) | **audit's guess was WRONG (review-rejected):** code already finds the row CONTAINING Joined + slices strictly after it (off-by-one fixed long ago; Joined intentionally never boxed). Real cause = Domain-specific pixel-scan/anchor edge case (extra "Sign in" modal row; suspicious identical joined_y across channels) — needs the rendered frame to diagnose | DIAGNOSED 2026-06-27 (`_h5.mts` = standalone composer+scan on Domain's REAL capture, per "don't guess"): scan finds 6 rows [URL, country, Joined(jIdx=2), **subscribers**(below[0]=#3), videos, views]; the subscribers band lands EXACTLY on "111K subscribers" (debug overlay verified). The identical `joined_y=571` is NOT bogus — it's the correct Joined position for the standard modal layout (channels sharing the layout share the y). The containment-match fix already corrected the old off-by-one; the user's report predates it. NO code change needed | `render-qa.mts` D (TODO): OCR each baked band, assert text matches narrated stat | 🟡 diagnosed-correct via standalone; confirm in rendered frame |
| 6 | Silent blank asset (umbrella) | a gem returns a valid path to a blank/flat image; compose composites it verbatim (only a NULL path triggers the missing-stub). Incl. whole-page-black captures: niche_4 channel_page rendered only the nav bar, body all black (#3, 2026-06-27) | `composeChannelLogosMontageMG` wrote a white canvas with no `composites.length` guard; `fetchYtAvatar` had no timeout/retry/fallback; AND the `THUMBS_UNLOADED` gate only counted unloaded thumbs, not a totally-empty page | `fetchYtAvatar`: 8s timeout + =s400-/original fallback + retry; montage: gray placeholder + THROW if 0 real avatars; **`THUMBS_UNLOADED` gate now also throws when a videos/channel_page capture has 0 grid cards** (page body never rendered → retry) | `render-qa.mts` B (montage non-blank + avatar presence); whole-capture-blank check = TODO E | ✅ montage+fetch+page-gate shipped; offline gate TODO |
| 8 | Render crash on transient pool drop | whole render dies mid-run: `Error: read ETIMEDOUT` → "Emitted 'error' event on BoundPool instance" → bare `Node.js vXX` | the Railway public-proxy drops an idle pooled connection → pg emits `'error'` on the pool; NONE of the long-lived pools had an `'error'` handler → unhandled event → process crash (killed a 7-niche render right after niche 7, 2026-06-27) | `pool.on('error', …warn…)` added to ALL long-lived pools (`db.ts`, `vector-db.ts`, `channel-b-verify.ts`, `similar-channels.ts` main+vec); pg evicts the dead client + dials a fresh one on the next query (active-query rejects are still handled by the existing smart-retry) | render must REACH completion: a `content_gen_producer_jobs` row + a freshly-mtimed `_latest*.mp4`; the completion watcher reports exit + counts swallowed idle-pool errors | ✅ shipped |
| 7 | Off-niche saturation/channel_b candidate | a movie-RECAP channel ("The Recap Mania") shown as a same-format peer for the AI-FILMS niche (niche_3 saturation) | the existing format/subject Gemini check (`channel-b-verify.classifyRelationship`) saw only titles + thumbnails — both look sci-fi — and `niche_spy_channels` has NO description, so "recaps existing movies" read as same-format as "creates original A.I films" | added self-stated channel DESCRIPTIONS (YT `part=snippet`, live-fetched + per-process cached, 6s/attempt) + a CREATE-vs-RECAP/compilation/reaction rule to the prompt; PROMPT_V 4→5 (invalidates stale verdicts); parallelized the per-niche classify loop (cap 6) so the recompute isn't ~50min | re-classify the shown saturation/channel_b candidates; assert no recap/compilation channel is rated `format_match=same` for an original-content niche | ✅ shipped — confirmed The Recap Mania flips same→different (→ dropped) |

## Post-render gate (must all PASS)

- [ ] #1 thumbnails: 0 black across all grid/channel_page captures
- [ ] #2 montages: every intro montage non-blank
- [ ] #3 VO: no garbled/stuttered tokens in the transcript
- [ ] #4 numbers: every spoken number matches its displayed capture; mm_opener/text_card numbers shown as DIGITS, not words
- [ ] #5 highlights: every stat highlight lands on the narrated row
- [ ] #6 captures: no whole-page-black capture (channel_page shows the body, not just the nav bar)
- [ ] #7 niche-match: no off-niche (recap/compilation/reaction) channel shown as a same-format peer
- [ ] #8 completion: render REACHED the end (producer-job row + freshly-mtimed mp4) — no mid-run pool crash
- [ ] beat completeness: every beat renders its intended composition (no blank/missing layers)

## Round 2 (2026-06-27): deep CONTENT verification — `scripts/local/render-verify.mts`

`render-qa.mts` passed job 139 **clean** yet the render had **11 real defects** — because that gate
only checks ASSET integrity (black/blank/stutter), never CONTENT correctness (does the spoken number
match the screen? is the highlight on the right row?). `render-verify.mts <jobId>` adds 4 CONTENT
checks, OCRing **the frame the render ACTUALLY composed** = the gem's `content_gen_tool_cache` asset
(NOT the latest `content_gen_yt_screens`, which can be a fresher re-capture the cache never picked up
— that gap IS defect #9). Vision = direct `gemini-2.5-flash` via xgodo proxy (PapaiAPI ignores inline
images). **Run BOTH gates after every render: `render-qa.mts` (assets) + `render-verify.mts` (content).**

| # | Class | Check | Root cause | Fix (shipped) |
|---|---|---|---|---|
| 9 | VO number ≠ displayed | narration number vs Gemini-OCR'd frame, compared as FLOOR-rounded YouTube label (142K≠141K, 10.7M≠10.4M) | stale `tool_cache` (key omits stat value + date_bucket) served an OLD frame under REFRESHED narration | fold the spoken stat into the capture args (`narr_snapshot`, `forceProofKind` + channel_b_top_video builder) so the FRAME re-resolves when the number changes. **Do NOT global-version-bump yt_capture** — it force-re-captures the hard channel_b/saturation channels (6/12 thumbs unloaded → never pass THUMBS_UNLOADED → render abort, learned the hard way job 140) |
| 10 | highlight on wrong row | re-scan about-panel: bottom-anchored subs row `rows[len-3]` exists + sits below the Joined center | joined-anchor `jIdx=-1` when the modal renders ~62px lower than its stored `joined_date.y` → fallback boxed the Joined row (Domain; Ponpon worked only by luck) | BOTTOM-anchor the invariant trailing stack subs→videos→views (`video-compose.ts` resolveBand); the scan runs fresh each compose, no cache bust |
| 11 | uniform DIM (overlay/backdrop) — distinct from dark theme/content | C check measures **p90**: a crisp capture keeps p90≥130 (bright chrome + white title text); a DIMMED one collapses to p90<100 (niche_7 was 73, max-white p99 still 255 from the duration badge so max-luma checks miss it). Whole-black stays luma<25 OR bytes<30KB. | a lingering popup's `tp-yt-iron-overlay-backdrop` dims the WHOLE page ~50% — intermittent (only niche_7/BillyFR, same code as the crisp ones). **Round-2 WRONGLY dismissed this as "intended dark theme"** — the tell is the WHITE banner/title text going gray, not the content. (Intended YT dark theme + genuinely-dark content both keep bright chrome → p90≥130, no false-flag.) | `yt-capture.ts`: strip `tp-yt-iron-overlay-backdrop`+popups before the GRID screenshot (NOT about_page, whose modal backdrop is intentional) + a post-shot **p90<100 brightness gate** that throws `CAPTURE_DIMMED` → retry fresh (added to the transient regex). Verified standalone: p90 73→231 |
| 12 | corrupted VO money | narration carries raw `$N,NNN` | EL garbles raw currency exactly like it garbled `$N RPM` | `verbalizeNumberPhrase` now spells `$N,NNN` → words (NARRATION only; the lump-sum text_card keeps digits) |
