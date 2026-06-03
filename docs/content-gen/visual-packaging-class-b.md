# Class B visual packaging tools (v1)

**Status:** Checkpoint — committed reference for the content-generation system.
**Scope:** Class B (indie faceless / Money Groot grammar). Other classes (A: brand studio with talking head; C: Hindi listicle) get their own checkpoints when we build them.
**Source video:** "11 Hidden Faceless YouTube Niches Explained" by Money Groot (videoId 14563, 121,507 views on a 41,900-sub channel — 2.90× views/subs ratio) + "20 Easy Faceless Niches Explained in 17 Minutes" (videoId 14435, 175,000 views, 4.81× views/subs — strongest indie performer in our corpus).
**Source corpus:** 352 fully-analyzed videos in custom niche #2, 110,587 segments.

---

## Why this document exists

The data-point inventory (`data-points.md`) defines **what** a generated script delivers. This document defines **how** each data point is visually packaged. Both are needed before any script generator can ship.

Class B is the visual grammar for indie faceless creators — no talking-head footage, no studio, no motion-graphics designer. Every primitive listed here is **renderable from our DB + a small static asset library** (icons, fonts, background swatches).

---

## The 5 general systems (the architecture)

These aren't individual primitives — they're **load-bearing principles** every shot conforms to. Get these wrong and the video looks off even if individual primitives are correct.

### A. Two-background semantic system

The video lives in two background modes with **semantic roles**:

| Background | Role | Corpus count (MG) |
|---|---|---|
| **White** | Narration / commentary / creator's voice | 196 mentions |
| **Dark gray** | YouTube-world / proof / data | 92 mentions |

The viewer subconsciously knows where they are (in narration vs in proof) just from background color. Mixing these — putting narration text on dark gray, or data on white — breaks the system's signaling.

**Render spec:**
- White bg: `#FFFFFF`
- Dark gray bg: `#2A2A2A` (approx — the YT-equivalent neutral)

### B. Card-with-padding composition

**No content fills the frame edge-to-edge.** Every YouTube screenshot, thumbnail, video clip is shown as a **padded card** sitting on the background. The background padding around content IS the layout — never let content bleed to the edges.

**Render spec:**
- Outer container: full-frame, solid background (white or dark gray per system A)
- Inner card: centered, max 80-85% of frame width, rounded corners (8-16px radius)
- Padding: at least 8% of frame height on each side
- Card content can be: a YT screenshot, a thumbnail, a video clip, or a text block

### C. Typographic hierarchy + color semantics within cards

Text on a card isn't flat. Within a single card, words have hierarchy by **size + weight + color**:

| Token role | Size | Weight | Color |
|---|---|---|---|
| Connecting words ("this would translate to", "from ads") | Normal | Regular | Neutral (black on white / white on dark gray) |
| Emphasis word ("**2 Tips**", "in **high cpm countries**") | Same or slightly larger | Bold | **Green** for money/opportunity, **Red** for warning, **Yellow** for highlight |
| Money-shot phrase ("**$29,000**", "**$6,000**") | Much larger | Bold | **Green** |

Color semantics are strict across the entire video:
- **GREEN** = money / opportunity / positive (`#22C55E` approx)
- **RED** = warning / danger / friction (`#EF4444` approx)
- **YELLOW** = highlight / "look here" (`#FACC15` approx, often as ring/circle/background fill)
- **BLACK / WHITE** = neutral narration

The color + size system is **the visual equivalent of vocal stress** — it delivers the emphasis a talking head would convey with voice inflection.

### D. Line-drawing characters as faceless-host PROXY

The shrug character, the cat-with-thumbs-up, the pointing hand, the "?" marks — these are not decorations. They are **substitutes for the host's face and reactions**.

A talking-head video uses facial expression to convey shrug, smile, eyebrow raise, pointing at the viewer. Money Groot has no face, so he substitutes a **stylized line-drawing icon** every time a facial reaction would normally appear.

**Implementation:** the icon library is the host's face decomposed into reusable reactions. Every emotional/reaction beat in the script → an icon from this library appears in the frame.

### E. YouTube native visual language as the video's OWN visual language

The video has no separate visual identity — it **borrows YouTube's**. Channel pages, About pages, thumbnail cards with "29M views • 7 months ago", thumbnail grids, search results, content clips in rounded-rectangle frames (mimicking YT's mini-player) — every visual element looks like it was lifted from YouTube itself.

**Why this matters:**
- Signals authenticity (viewers instinctively trust what looks like YouTube)
- Removes the need for custom motion-graphics
- Says "I'm showing you the real thing" not "I'm summarizing the real thing"

**Render spec:** all proof-side visuals must visually match YouTube's actual rendering (current YT typography, current channel-page layout, current thumbnail aspect ratio, current "X views • N ago" timestamp format).

---

## The 5 emphasis / annotation tools (the primitives)

These are the reusable atomic primitives the generator places per beat. Each one delivers one specific data point or emphasis moment.

### 1. Icon library (host-reaction proxies)

A small static SVG library, ~10-15 icons, drawn in a consistent line-drawing style. Each icon corresponds to a host-reaction beat:

| Icon | Beat / use |
|---|---|
| Shrugging character with "?" marks above head | "we don't know exactly", "let's estimate", uncertainty |
| Pointing hand (palm out, finger extended toward viewer) | "this is for YOU", direct address |
| Green circle with white checkmark | confirmation, "this works", "this is safe" |
| Green circle with white dollar sign | monetization beat, "you make money" |
| Cat with thumbs up | viewer-appreciation beat ("if you're watching this far…") |
| Red strikethrough over speaker icon | "muted audio", "you can't use this" |
| Speaker icon with sound waves | "audio is used here" |
| Chalkboard with chalk text | concept tag / educational emphasis (see tool #5 below) |
| Generic shrug emoji | quick reaction beat |
| Stack of dollar bills / cash pile | money emphasis (sparingly) |

**Render spec:** each icon is a flat SVG asset, single color (usually black on white bg / white on dark bg), shown full-frame as a single card or composed with text. Consistency of style across icons is mandatory — they must all look like they came from the same line-drawing set.

### 2. "Most-popular video" isolated callout card

Distinct framing from regular thumbnail cards in a grid. Used when the script narration cites a specific top video:

> *"And their most popular video has more than 1 million views."*

**Render spec:**
- Single thumbnail centered on dark gray background
- Native YT layout: thumbnail image + title text below + "1.3M views • 1 month ago" timestamp
- Larger size than the per-niche thumbnail cards in the proof grid (occupies ~60% of card area, vs ~30% for grid items)
- Held on screen 1.5-2.5 seconds (longer than the rapid-fire thumbnail grid cards)
- No grid context around it — it's THE specific video being called out

### 3. Yellow-circle / highlight annotation on element within a screenshot

When a real YT screenshot is shown (channel page, About page, search results), specific elements get annotated:

**Common annotation styles:**
- **Yellow circle** ring around a specific subscriber count, view count, or thumbnail
- **Yellow background fill** behind a specific number or word in the screenshot
- **Yellow highlight box** around a row/bullet in a TOS or policy page

**Render spec:** SVG overlay on top of the screenshot. Yellow color matches the typographic-emphasis yellow (`#FACC15`). Ring stroke is 4-6px thick. Animation can fade in over 200ms.

**When to use:** every time speech references a specific element visible in the on-screen screenshot. If subs are stated and the channel page is on screen → yellow-circle the subs number.

### 4. Inline color highlighting within a text card

Within a text card, specific phrases get colored (not whole-card recolor). The card itself stays standard (white-bg/black-text or dark-gray-bg/white-text), and ONE phrase inside it is rendered in green or red.

**Example:**

```
[ white bg ]
   Here are  2 Tips  from me
              ↑ this in green, rest black
```

```
[ white bg ]
   free to use  + give proper credit, no  copyright issues
                                          ↑ this in red
```

**Render spec:** simple inline `<span>` with color override. Same font size as surrounding text (NOT bigger — that's the money-shot full-card pattern in system C). Bold-weighted.

**Color rules:**
- Green: opportunity, money, positive, money-time-frames
- Red: warning, friction, "don't do this"
- Yellow: not used for inline text (yellow is reserved for highlights/circles)

### 5. Chalkboard concept tag

A chalkboard graphic with chalk-style text — used to tag a key conceptual word the narrator wants to emphasize.

**Example use case:** narrator says *"the storytelling is very strong"* → cut to **chalkboard with `STORYTELLING` written in chalk** for 1-2 seconds → cut back to next narration card.

**Render spec:**
- Background: dark green or black "chalkboard" texture
- Text: serif chalk-style font, white/cream color (`#F8F4E3`)
- Centered, single word or 2-3 words max
- Often shown with the word being the conceptual takeaway for the segment

**When to use:** once per niche segment at most (sparingly). Reserved for the **load-bearing conceptual word** of the niche's explanation. Overusing it dilutes the signal.

---

## How the systems and tools compose

A typical niche-reveal segment uses ALL FIVE systems and several primitives in sequence:

```
[white bg] (system A)
   Number 4
   ← text card, system B + C (typographic hierarchy)
   ← niche.category data point

[white bg]
   Movie & TV show breakdown
   ← niche name text card

[dark gray bg] (system A flip — entering YT-world)
   YT channel page screenshot in padded card (system B)
   with yellow-circle annotation on subs (tool #3)
   ← channel.subscribers data point

[white bg + line-drawing shrug character with "?"] (system D)
   "If we assume"
   "$6 RPM" (green) ← system C inline color
   ← creator's RPM math beat

[dark gray bg]
   Single specific top-video callout card (tool #2)
   "Their most popular video — 1.3M views • 1 month ago"
   ← video.top_video data point

[white bg]
   "this would translate to"   ← system C: connecting words, black
[white bg]
   $6,000                       ← system C: money shot, huge green
[white bg]
   "from ads"                   ← system C: connecting words, black

[dark gray bg + chalkboard]
   STORYTELLING                 ← tool #5: concept tag

[dark gray bg + cat with thumbs up icon] (system D)
   "if you're watching this far, I appreciate it"
   ← viewer appreciation beat
```

Every shot lives in one of the two background modes (system A), composed as a padded card (system B), with text following the hierarchy rules (system C), reactions delivered as icons (system D), all styled to look like YouTube native (system E).

---

## What we can render — feasibility

All five systems and all five primitives are **renderable programmatically** with no production capacity needed:

| Tool / System | Render technology |
|---|---|
| A. Two-background system | CSS solid background-color |
| B. Card-with-padding | CSS layout (flexbox/grid + padding) |
| C. Typographic hierarchy + color | CSS typography + inline `<span>` with color |
| D. Line-drawing characters | Static SVG asset library (~10-15 assets, one-time creation) |
| E. YT native visual language | HTML/CSS templates mimicking YT channel-page, About-page, thumbnail-card, search-results — fed by our DB |
| 1. Icon library | Subset of D's SVG library |
| 2. Most-popular callout card | Same template as thumbnail card with larger sizing rules |
| 3. Yellow-circle annotation | SVG `<circle>` overlay on top of screenshot |
| 4. Inline color highlighting | `<span style="color: …">` inside text card |
| 5. Chalkboard concept tag | CSS template with chalkboard background asset + chalk font |

**One-time asset cost:** the ~15 SVG icons in the line-drawing library + chalkboard texture + chalk font + the YT-mimicking HTML/CSS templates. That's the entire production infrastructure for Class B generation.

---

## What's NOT in Class B (intentional exclusions)

These are Class A signals — they belong in a separate template doc when/if we build Class A. Including them in Class B would break the aesthetic:

- Talking head on camera (host with gestures)
- Social Blade overlays
- Custom "Estimated monthly earnings $X" branded callouts
- Dark grid pattern background or blue gradient bg
- Particles / sparkles / motion-graphics flourish
- Animated word-by-word text reveals (replaced by sequential one-line text cards)
- VidIQ / TubeBuddy tool overlays
- Subscribe button animations (Money Groot's CTA uses none)
- End-card video-thumbnail grids (Class A pattern)
- Browser URL bars visible (looks tutorial-y)
- PIP / corner-webcam host overlays

## What's NOT in this v1 (deferred for v2+)

- Class A grammar (brand studio) — separate doc when we build that template
- Class C grammar (Hindi listicle) — separate doc, needs corpus mining of the 32 excluded Hindi videos first
- Audio / SFX vocabulary — separate doc (this one is visual-only)
- Per-data-point slot → visual primitive mapping — that's the next checkpoint, lives in `slot-rendering-class-b.md` when we write the generator

## Next checkpoints (queued)

1. **Audio/SFX vocabulary doc** — corpus mining of `audio_description` to extract music genre, SFX patterns, when each plays
2. **Slot-rendering map** — for each data-point slot in `data-points.json`, which of the visual tools above are used to deliver it
3. **Class A visual packaging doc** — when we decide to add the brand-studio template
4. **Class C visual packaging doc** — when we mine the Hindi corpus
