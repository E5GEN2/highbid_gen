# Render Audit: job-126-1781169613938.mp4

## METADATA
- **File:** `/Users/rofe/Desktop/lab/hbgen/highbid_gen/clips/producer_renders/job-126-1781169613938.mp4`
- **Duration:** 52.85s | **Resolution:** 1920x1080 (16:9 horizontal) | **FPS:** 59.94 | **Audio:** AAC 44.1kHz stereo
- **Slots rendered (DB, job 126):** intro_card, niche_name_card, channel_intro, channel_page_full, channel_proof_1, channel_proof_2, top_views_rapid x3, top_videos_pano, top_video_callout, money_math x5 (assumption/rpm/translates/lump_sum/closer), video_cta x4
- **Frames:** /tmp/audit/f001–f026.png, 1 frame per 2s (fNNN ≈ t = 2N−1 seconds)
- **Hard cuts detected (scene>0.25):** 2.84s, 5.66s, 7.53s, 9.43s, 19.42s, 23.10s, 25.37s, 30.43s, 50.49s — note the 10-second gap with NO cut between 9.43s and 19.42s

## SLOT-BY-SLOT OBSERVATIONS

**intro_card (0–2.8s, f001):** Three circular channel avatars evenly spaced on off-white (#fdfdfd). No title text, no labels, lots of empty white. Center avatar (phantomized — dark circle, two blurred red eyes) reads well; sparse composition, feels like an unfinished title card.

**niche_name_card (2.8–7.5s, f002–f003):** Word-by-word typewriter reveal of "Fictional Creature Size Comparisons." Big bold black on white, fully legible. f002 catches just "Fictional" sitting alone left-of-center — the single line is left-anchored, so early reveal frames look lopsided. ~4.7s for a 5-word card is slow.

**channel_intro (7.5–9.4s, f004):** YouTube channel header card (dark rounded rect) centered on white. Clean, legible. Channel description is truncated mid-word at the card edge ("If you…" cut without ellipsis) — f004.

**channel_page_full (9.4s–~11s, f005):** Full-bleed channel page screenshot, dark theme. Video titles are tiny and illegible at viewing size; the screenshot's gray "SUBSCRIBE" banner art dominates. Background here is the screenshot itself (corner #5e5e5e) — the only slot with mid-gray edges, breaking the white/charcoal pattern.

**channel_proof_1 + channel_proof_2 (~11–19.4s, f006–f010):** Single about-panel screenshot (dark card on white) on screen for ~8–10 SECONDS with no cut — the only change is the olive-yellow highlight moving from "107K subscribers" (f006–f007) to "40,144,270 views" (f008–f010). f006/f007 are pixel-identical, f008/f009/f010 are pixel-identical. Longest dead stretch in the video. Right half of the card is empty dark space; highlight is a muddy olive (#aaa00-ish) with dark text inside.

**top_views_rapid x3 (19.4–25.4s, f011–f012):** Single video-thumbnail cards on dark #212121. ~2s per card — not especially "rapid." Card-to-card cuts are low-contrast (dark card → dark card; one of the three transitions didn't even register as a scene change). All thumbnails are near-identical gray monster silhouettes, so consecutive cards look like the same frame at a glance.

**top_videos_pano (25.4–~27s, f013):** Full-bleed 3x3 video-grid screenshot. Top row of cards is cropped mid-thumbnail at the frame's top edge. Text far too small to read. Transition INTO money-math callout was soft (no scene spike) while neighbors are hard cuts — inconsistent transition language.

**top_video_callout (~27–30.4s, f014–f015):** "How BIG is THE BOILED ONE… 7.9M views" card, dark thumbnail on WHITE — note: rapid cards put the identical card style on dark #212121, callout puts it on white. Two background treatments for the same content type. f014/f015 are identical — ~3.5s static.

**money_math (30.4–~41s, f016–f021):** White bg, huge bold typography. "Even if" alone on screen at f016 (typewriter mid-reveal, left-anchored, looks empty). "$3 RPM" in green with a clip-art stick figure + question marks (f017) — icon style clashes with the screenshot-real aesthetic elsewhere. "that one video alone has probably made" (f018–f019), "$24,000" giant green centered (f020). Color logic (money = green) is consistent. No hard cuts in this whole stretch — all reveals on shared white.

**video_cta x4 (~41–52.6s, f021–f026):**
- f021–f022: "So these are the 1 faceless" — the literal digit "1" in running prose reads as template output ("the 1 faceless channels…"); grammatically off for a single-niche render.
- f023–f024: "Huge potential." + green check — pixel-identical frames, ~4s static.
- f025: "Discover more." with a thumbs-up outline icon that renders oddly — looks rotated/mirrored with a stray lobe on the left, mitten-like.
- f026 (50.5–52.6s): **worst frame in the video** — "Check out this video." rendered in near-black (#111, gray 11–46) on charcoal #282828. Text is effectively invisible. White cat icon above has circular-arrow "ears" and a detached small circle floating at its lower right (bell? toggle?) that reads as a rendering glitch. Also the only dark CTA card after three white ones, via hard cut at 50.49s.

## AUDIO PROFILE
- **Single VO track, NO music bed.** Inter-sentence gaps drop to −67…−94 dB RMS (digital silence). A music bed would floor around −35/−45 dB.
- VO starts at t=0 with no lead-in; speech sits around −24 to −28 dB RMS.
- **Silent gaps between slots:** ~8.9s (−69dB), ~18.9s (−73dB), ~24.8s (−91dB, a full ~0.5s of dead air before the pano), ~29.8s (−67dB), ~33.7s (−62dB); softer pauses at 13.9s, 39.2s, 43.6s, 46.6s, 50.1s (−39 to −49dB).
- Trailing silence from ~52.6s to end.
- Net effect: VO sentences with hard silence between them — gaps are audible as dropouts, especially the 24.8s one.

## ROUGH EDGES
1. **f026 — illegible CTA text:** "Check out this video." is #111-on-#282828; contrast is near zero. Cat icon has a detached floating circle artifact.
2. **f006–f010 — 10s static stretch:** one screenshot, no cut from 9.43s→19.42s; only a highlight rectangle moves. Five consecutive sampled frames are two unique images.
3. **f022 — "the 1 faceless":** raw digit interpolated into prose; reads broken for a 1-niche render.
4. **f025 — malformed thumbs-up icon:** rotated/mirrored-looking outline glyph.
5. **No music bed + hard silence gaps** (esp. ~0.5s of −91dB at 24.8s) makes slot seams audible and the edit feel unfinished.
6. **Background inconsistency:** white #fdfdfd slots vs dark #212121 (rapid) vs #282828 (cta_card_4) vs full-bleed screenshot edges #5e5e5e (f005, f013) — three different "darks" plus mid-gray bleed.
7. **Same content, two treatments:** video cards on dark bg in rapid (f011/f012) but on white in callout (f014).
8. **f013 — pano grid cropped:** top row of video cards cut mid-thumbnail; all text illegible.
9. **f004 — description truncated mid-word** at card edge, no ellipsis.
10. **Mixed transition language:** hard cuts (2.84/9.43/19.42/50.49s) interleaved with soft fades (pano→callout) and 20s stretches with no cuts at all (30.4–50.5s); rapid-card cuts are visually weak (dark-to-dark, near-identical silhouette thumbnails).
11. **f016/f021 — typewriter dead frames:** "Even if" / "So" alone on a white 1920x1080 canvas for ~1–2s each.
12. **f017 — clip-art stick figure** clashes stylistically with the YouTube-screenshot realism of the first half.