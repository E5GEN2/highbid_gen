# Class B slot-rendering map (v1)

**Status:** Checkpoint — couples the data-point inventory with the visual + audio packaging specs into a concrete per-slot render contract.
**Inputs:** `data-points.json` (what to deliver) × `visual-packaging-class-b.json` (visual primitives) × `audio-sfx-class-b.json` (audio primitives) → this doc.
**Use case:** when the generator fills in a niche-reveal segment, it looks up each slot here to know exactly **how** to render that data point — background mode, composition, hold duration, icon, color, SFX, music cue.

---

## How to read each row

Every slot has a render contract:

| Field | Meaning |
|---|---|
| **`bg_mode`** | Which two-background semantic to use (`white` = narration, `dark_gray` = YT-world / proof) |
| **`composition`** | Which visual composition primitive (text-card / yt-screenshot-card / thumbnail-card / icon-card / chalkboard-card / mini-player-card / annotated-screenshot) |
| **`primitive`** | Specific named visual primitive from `visual-packaging-class-b.json` if applicable |
| **`icon`** | From the line-drawing icon library if one is used (e.g. `shrug_with_question_marks`, `dollar_sign_green_circle`) |
| **`color_treatment`** | Whether and how typographic color semantics apply (e.g. `money_shot_green`, `inline_red_warning`, `neutral`) |
| **`hold_seconds`** | How long the card stays on screen |
| **`audio_cue`** | Music override + SFX punctuation if any |

---

## The slot rendering table

### Money / earnings slots (the $ trio + lump sums)

| Slot | bg_mode | composition | icon | color | hold (s) | audio_cue |
|---|---|---|---|---|---|---|
| `money.yearly` ($1.1M/year) | white | **text-card sequence** ("this could mean" → "**$1.1M/year**" → "from ads") | — | money_shot_green on $X; black on connectors | 0.8 / **1.8** / 0.8 | ding (high pitch) on $X card |
| `money.daily` ($1k/day) | white | same sequence pattern | — | money_shot_green | 0.8 / **1.5** / 0.8 | ding on $X |
| `money.monthly` ($24k/month) | white | same | — | money_shot_green | 0.8 / **1.5** / 0.8 | ding on $X |
| `money.per_video` ($70 a video) | white | text-card sequence + the math: "$70 each → 3 uploads → $210" | — | green on $; black connectors | 0.8 / 1.5 / 0.8 / 1.5 / 0.8 / **1.5** | ding cascade — one per $ reveal |
| `money.lump_sum` ($29,000 from one video) | white | text-card sequence: "Even if we assume" → shrug character + "$1 RPM" → thumbnail card → "$29,000" → "from ads" | `shrug_with_question_marks` for assumption beat | green on $1 + $29,000 inline; bigger green for final $ | full sequence ~6-8s | ding on each $ reveal; cash_counting (optional) on final $ |

**Pattern:** Money is ALWAYS revealed via a sequential text-card chain that ends in a money-shot green card with the dollar figure. RPM math is never shown — the shrug character + "$X RPM" is the "we assumed this" beat, then the conclusion lands as money-shot. **Ding SFX on every $ reveal**; pitch rises with the figure size.

---

### Channel-scale slots

| Slot | bg_mode | composition | icon | color | hold (s) | audio_cue |
|---|---|---|---|---|---|---|
| `channel.subscribers` | **dark_gray** | **yt-screenshot-card** (YT channel page OR YT About/Stats page) + **yellow_circle_screenshot_annotation** on the subs number | — | yellow ring on the number; subs digit stays original color | 1.5-2.0 | whoosh on page-load; ding on yellow circle reveal |
| `channel.video_count` | **dark_gray** | yt-screenshot-card (channel page — video count visible) | — | yellow ring optional | 1.0-1.5 | whoosh on entry |
| `channel.total_views` | **dark_gray** | yt-screenshot-card (Stats page — total views visible, yellow ring) | — | yellow ring on the number | 1.5 | whoosh + ding |
| `channel.age` | **white** | text-card ("just X months old" or "started X years ago") | — | neutral | 1.2 | subtle whoosh |
| `channel.upload_rate` | **dark_gray** | yt-screenshot-card (channel page showing video grid with upload dates) + text overlay "3 videos per day" in green | — | inline green on rate | 1.5 | subtle whoosh + click (optional, suggests cursor) |

**Pattern:** Channel-scale stats live in YouTube-screenshot land (dark_gray bg). When the narration calls out a specific number, the **yellow circle annotation** highlights it on the screenshot, optionally with a ding SFX as the circle reveals.

---

### Per-video slots

| Slot | bg_mode | composition | icon | color | hold (s) | audio_cue |
|---|---|---|---|---|---|---|
| `video.top_video` (the cited #1 video) | **dark_gray** | **most_popular_callout_card** primitive — single thumbnail centered, YT-native layout (title + "X views • N ago") | — | yellow ring optional on the view count | **1.5-2.5** (longer than grid items) | ding on entry |
| `video.views` (per-thumbnail in a sequence) | **dark_gray** | series of single thumbnail-cards in rapid succession (3-5 thumbnails on dark_gray bg, each ~1s) | — | neutral | 1.0 each | whoosh per card transition |
| Thumbnail grid showcase | **dark_gray** | grid-of-thumbnails layout (8-12 thumbnails of the channel's top videos with view counts) | — | neutral | 3-4 | whoosh on grid reveal |

**Pattern:** When narration cites THE most popular video specifically, it gets the larger callout card primitive with ding emphasis. When narration is enumerating multiple top videos in a sequence ("29M views, 10M views, 8.8M views…"), use rapid-fire thumbnail-cards.

---

### Niche / category slots

| Slot | bg_mode | composition | icon | color | hold (s) | audio_cue |
|---|---|---|---|---|---|---|
| `niche.category` (niche name reveal) | **white** | text-card sequence: "Number N" → niche name | — | neutral; optional inline green on a keyword | 0.8 / 1.5 | whoosh + ding on number; whoosh on niche-name card |
| Niche concept emphasis | **dark_gray** | **chalkboard_concept_tag** primitive (chalkboard with chalk-text) | — | chalk-cream text | 1.0-1.5 | soft chime |
| `competition.zero` ("low competition") | white | text-card ("only N channels in this niche") | — | inline green on count if low | 1.5 | whoosh + subtle ding |
| `competition.saturated` | white | text-card ("most channels avoid this") | — | inline red on "avoid" | 1.5 | whoosh |

**Pattern:** Niche IDs live in narration land (white bg). When a single concept word is the takeaway, promote it to a chalkboard tag for the educational emphasis beat.

---

### Format / production slots

| Slot | bg_mode | composition | icon | color | hold (s) | audio_cue |
|---|---|---|---|---|---|---|
| `format.production_type` (e.g. "AI voiceover + animation") | white | text-card ("the format is simple:" → cards for each element) | optional `checkmark_green_circle` per element | inline green on each element | 1.0 each | subtle whoosh per element |
| `format.tool_named` (e.g. "ElevenLabs") | mixed | text-card ("they use") + cut to tool screenshot/logo in mini-player frame on dark_gray | — | neutral | 1.5 | subtle whoosh + optional click |
| Recipe formula ("they just record gameplay and upload") | mixed | sequence: narration text-cards (white) + mini-player-card of actual content (dark_gray) demonstrating | — | neutral | 2-4s per content sample | **DIEGETIC: source channel audio underneath** (ducked) |

**Pattern:** Recipe is always shown WHILE narrated. Words on white-bg, content samples on dark_gray-bg with the source channel's own audio (the diegetic mirroring system).

---

### Time / recency slots

| Slot | bg_mode | composition | icon | color | hold (s) | audio_cue |
|---|---|---|---|---|---|---|
| `time.posting_year` | white | text-card (used in title framing, e.g. "in 2026") | — | neutral | (part of intro card sequence) | — |
| `growth.in_period` ("got X views in N months") | mixed | text-card "got" (white) → thumbnail-card showing the channel's top video (dark_gray) with "X views" callout → text-card "in just N months" (white) | optional `shrug_with_question_marks` for "and now look" beat | green on view count + month count | 2-3s total | ding on view count |

**Pattern:** Growth claims combine a text-card buildup with a proof thumbnail-card, ending in the surprising number.

---

### CTA slots

| Slot | bg_mode | composition | icon | color | hold (s) | audio_cue |
|---|---|---|---|---|---|---|
| Viewer appreciation beat ("if you're watching this far…") | white | text-card + `cat_thumbs_up` icon | `cat_thumbs_up` | neutral | 2.0 | music ducks deeper; no SFX |
| Subscribe ask | white | text-card ("hit subscribe") | — | neutral; optional inline green on "subscribe" | 1.5 | none (MG uses no audio cue — clean text card) |
| Next-video pitch ("check out this video") | white | text-card pointing at off-screen thumbnail with `pointing_hand` icon | `pointing_hand` | inline green on "check out this video" | 2.0-2.5 | ascending_electronic_sting on final beat |

**Pattern:** CTA stays in narration land (white bg) — no Subscribe-button animations, no end-card grids. Calm, text-card-driven close with one ascending sting as the music ends.

---

### Avoid slots (loser-coded)

These slots from `data-points.json` are marked `phase: AVOID` and should NEVER be rendered:

| Avoid slot | What was banned | Why |
|---|---|---|
| `money.rpm_exposed` | Showing `views × RPM = $` math directly | Winners hide the math — exposing it reads as a calculator showing its work (0.75× uplift) |
| `social.likes` | Like counts as social proof | Weaker than view counts (0.6× uplift) |
| `time.posting_window` ("past 90 days") | Time-windowed framings | Reads hedgy / conditional (0.53× uplift) |

If the generator's slot-fill logic encounters one of these, **skip the slot entirely** (do not render).

---

### Proprietary slots (Phase 2)

When Phase 2 ships, these get their own rendering specs. Initial sketch:

| Slot | bg_mode | composition | icon | color | hold (s) | audio_cue |
|---|---|---|---|---|---|---|
| `cohort.saturation_rank` | white | text-card ("**4th** most-active channel in this niche") | — | inline green on the rank | 1.5 | ding |
| `cohort.growth_multiplier` | white | text-card + growth-rate visual ("**3.2× the cluster median**") | — | inline green on the multiplier | 1.5 | ding (rising pitch) |
| `novelty.embedding_distance` | white | text-card ("only **3 channels** in our index look like this") | — | inline green on the count | 1.5 | soft chime |
| `cohort.first_mover` | white | text-card ("created **41 days ago**, already top **5%**") | — | inline green on both numbers | 2.0 | ding on each number |
| `niche.emergence_rate` | white | text-card ("**28 new channels** entered this niche in 60 days") | — | inline green on count | 1.5 | ding |

These are positioned as **our proprietary edge** — a small "we tracked it" badge could optionally appear on the card to brand the proprietary signal.

---

## The full per-niche beat sequence (composed from slots)

Putting it all together, one full niche-reveal segment becomes a defined sequence of slot renderings:

```
[white]   "Number 4"                                   ← niche.category (intro card)
            ding + whoosh
            0.8s

[white]   "Movie & TV show breakdown"                  ← niche.category (name card)
            whoosh
            1.5s

[white]   3 circular profile pics on white bg          ← niche.examples_mosaic
            subtle whoosh
            2.0s

[dark]    YT channel page screenshot of #1 example     ← channel.subscribers + .video_count
            + yellow circle on subs number               + .total_views (composed)
            whoosh on page-load + ding on circle
            2.5s

[dark]    YT About/Stats page                          ← channel.age + .subscribers
            + yellow circle on subs
            whoosh + ding
            2.0s

[dark]    most-popular-video callout card              ← video.top_video
            ding
            2.0s

[dark]    series of 3 thumbnail-cards in sequence      ← video.views (top 3)
            whoosh + (optional ding cascade)
            3.0s total (1s each)

[dark]    thumbnail grid (8-12 thumbnails)             ← video.views (panoramic)
            whoosh on grid reveal
            3.0s

[white]   "Even if we assume" (text)                   ← money.lump_sum opener
            subtle whoosh
            0.8s

[white]   shrug character + "$6 RPM" green inline     ← money.rpm_silent (HIDDEN math)
            (icon: shrug_with_question_marks)
            soft whoosh
            1.5s

[dark]    thumbnail-card returns                       ← money.lump_sum: source of math
            (the cited top video)
            no audio change
            1.5s

[white]   "this would translate to"                    ← money.lump_sum connector
            subtle whoosh
            0.8s

[white]   "$29,000" — huge green money shot            ← money.lump_sum: payoff
            DING (high pitch)
            1.8s

[white]   "from ads"                                   ← money.lump_sum connector
            subtle whoosh
            0.8s

[dark]    mini-player-card with content clip          ← recipe.formula
            (source channel's actual content)
            DIEGETIC AUDIO from source (ducked under voiceover)
            3-5s

[dark]    chalkboard: STORYTELLING                     ← niche.concept_tag
            soft chime
            1.2s

[dark]    cat_thumbs_up icon + appreciation text       ← viewer appreciation beat
            music ducks deeper
            2.0s

[whoosh transition + music fades to next track]       ← niche boundary
```

**Total per-niche duration: ~35-60 seconds** matching Money Groot's median niche duration.

---

## What the generator does with this

Per the data-point inventory's slot-fill priority, the generator:

1. **Picks N referenced channels** for the niche (querying `niche_spy_videos` / `shorts_channels` joined with cluster assignment)
2. **Fills slots per channel**: subs, video_count, age, top_video, $ figures (via niche RPM × views), etc.
3. **For each filled slot, looks up THIS table** to determine: bg_mode + composition + icon + color + hold + audio
4. **Concatenates the renderings** into the per-niche beat sequence above
5. **Switches music track** at each niche boundary (per `audio-sfx-class-b.json` rules)
6. **Generates voiceover** from the connecting narration text + slot-specific phrases
7. **Renders** the final video by composing HTML/CSS templates frame-by-frame, the SVG icon library, the YT-mockup CSS, and the music + SFX mix

Every slot, every audio cue, every icon, every color: defined here. No prompting Gemini to "decide on a style" mid-generation — it's deterministic.

---

## Next checkpoints

1. `script-skeleton-class-b` — the per-niche script template (what the narrator actually SAYS, slot-by-slot, with the connecting text between data points)
2. `render-template-stack` — the actual HTML/CSS templates for each composition primitive (yt-channel-page mock, yt-about-page mock, thumbnail-card, mini-player, chalkboard, etc.)
3. `icon-library-asset-spec` — the SVG icon set design spec (15 icons × line-drawing style)
4. `slot-rendering-class-a` — same map for Class A when we build that template
5. `slot-rendering-class-c` — same for Hindi listicles when we build that
