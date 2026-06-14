# When MG shows the video-performance beats (and when it doesn't)

Source: full transcript + beat-span decode of the pivot anchor
(`video_analysis_jobs` id=1, video 14563 "11 Hidden Faceless YouTube
Niches", 454 segments) cross-referenced with `mg-og-beat-spans.json`.

User observation (2026-06-14): "OG MG does not do `top_video_callout` and
`top_views_rapid` for every channel." Correct — and we currently emit them
for every niche. This documents the actual rule.

---

## THE DATA — these beats are RARE, not per-channel

Across the OG's 11 niches:

| Beat | Niches that have it | Count |
|---|---|---|
| `top_views_rapid` | **n1, n3** | 2 / 11 |
| `top_video_callout` | **n1, n5** | 2 / 11 |
| `top_videos_pano` | **n1** (×2) | 1 / 11 |
| **none of the three** | n2, n4, n6, n7, n8, n9, n10, n11 | **8 / 11** |

**The default is to show NONE of them.** 8 of 11 channels go
`channel_intro → channel_page_full → channel_proof_2 (total views) →
money_math` with no video showcase at all. The proof is the **total view
count stated in narration**, and money_math runs on that total.

---

## THE ONE RULE

> The video-performance beats fire only when a **specific video angle adds
> something the channel totals don't.** If the story is just "this channel
> is big," MG states the total and runs the money math — no showcase.

Each beat has a distinct trigger, all observed:

### `top_views_rapid` — the wall-of-numbers OR the format-as-hook
Fires when EITHER:
- **(a) the view spread is genuinely exceptional** and worth a flex.
  - n1: *"And their views are absolutely unbelievable. They have videos with
    29 million views, 10 million views, 8.8 million views…"* — a 400K-sub
    channel with 29M-view uploads. The numbers themselves are the hook.
- **(b) the example TITLES convey the niche's distinctive/funny format.**
  - n3 (Absurd Ranking): *"…in a funny way like Top 10 numbers to live in,
    or Top 10 letters to use as a chair."* — this is NOT view counts; it's
    rattling off absurd video *titles* so the viewer gets the comedic premise.

It does **not** fire to list ordinary view counts on a typical channel.

### `top_video_callout` — one video worth isolating
Fires when a SINGLE video deserves to be pulled out, for one of two reasons:
- **(a) it anchors the money_math** (a dramatic single-video earner).
  - n1: *"Let's take that video with 29 million views."* → money_math:
    *"…that one video alone has probably made around $29,000 from ads."*
    The callout exists to set up a per-video money calc.
- **(b) it illustrates a concrete success mechanic of the niche.**
  - n5 (Meme Explained): *"…when they explained this meme during its early
    viral days, that video got over 1 million views."* → teaches the timing
    lesson (ride the trend early). The video is an *example*, not the money base.

It does **not** fire as a generic "their most popular video has X views."

### `top_videos_pano` — the over-performing catalog (showcase)
Rarest (n1 only, used twice): shown when the WHOLE catalog over-performs —
n1: *"almost every single upload pulls in hundreds of thousands of views."*
In practice this is the **opener's showcase**: MG front-loads its most
visually rich, jaw-dropping example to hook the viewer in niche #1.

---

## money_math basis (why the callout is usually absent)

money_math runs on the **channel TOTAL views** for 10 of 11 niches
("over 13 million total views… $39,000"; "14 million views… $50,000";
"1.5 billion total views… $180,000"). The **only** per-single-video money
calc is n1 (29M-view hero video → $29,000), and that is exactly the niche
that gets `top_video_callout`. So:

> `top_video_callout` ⇔ money_math anchored on ONE standout video.
> Total-based money_math ⇒ no callout.

---

## How this maps to our system (the gap)

`listicle-builder.ts` inserts `top_videos_pano` + `buildTopViewsRapidFireSlots`
after **every** `channel_proof_1` (≈ lines 1394-1395, and the fallback at
1406-1407), and `top_video_callout` arrives from the writer unconditionally.
We show all three for every niche — MG shows them for ~18% / ~18% / ~9%.

**Gating to absorb (proposed; thresholds are starting points to tune):**

- **Default: emit NONE.** Channel section = page_full → proof (totals) →
  money_math on totals. This already matches 8/11 of the OG.
- **`top_views_rapid` (view-flex form, A):** only when the channel's top
  videos are genuinely exceptional — e.g. top video ≥ ~1M views OR top video
  ≥ ~10× the channel median (a real standout spread). The "funny-titles"
  form (B) is content-style-driven and harder to auto-detect — defer, or
  trigger on a comedic/format-driven niche tag.
- **`top_video_callout`:** only when one video dominates enough to anchor the
  money_math on it (then switch money_math basis from total → that video).
  Otherwise omit and keep money_math on totals.
- **`top_videos_pano`:** reserve for an over-performing catalog and/or the
  **first niche** (the opener showcase). Not a default per-channel beat.
- **Position effect:** niche #1 (the hero) may carry the fuller showcase
  when it qualifies; later niches stay lean. MG front-loads the spectacle.

Threshold note: 2/11 + 2/11 + 1/11 is the empirical base rate from this one
reference video — keep these beats the EXCEPTION, not the rule, and widen
only with more reference data.
