# Class B audio / SFX vocabulary (v1)

**Status:** Checkpoint — companion to `visual-packaging-class-b.md` and `data-points.md`.
**Scope:** Class B (Money Groot grammar). Other classes get their own audio specs.
**Source video:** "11 Hidden Faceless YouTube Niches Explained" by Money Groot — 454 segments, 14m04s, 14 distinct music-track transitions, ~70 SFX events.

---

## The 4 audio systems (the architecture)

Same logic as the visual side — these are load-bearing principles every audio moment conforms to.

### A. Multi-track music rotation by section semantic

Music **isn't one track playing throughout**. Money Groot switches tracks at semantic boundaries — and the track choice IS a signal of what mode the video is in. 14 transitions across 14 minutes.

| Mood track | Use-case | Count in MG |
|---|---|---|
| **Upbeat light** | Default narration baseline | 157 segments |
| **Upbeat motivational** | Proof / inspirational moments | 74 |
| **Upbeat tech-themed** | Niche-specific (tech topics) | 29 |
| **Calm uplifting** | Tips / educational moments | 28 |
| **Soft calm** | Intimate / personal advice | 1 |
| **Upbeat calm** | CTA outro | 1 |
| **Upbeat corporate-style** | Section pivot transitions | 1 |
| **Upbeat modern inspirational** | Niche-specific (inspirational topics) | 1 |
| **Phonk / electronic-funk** | Diegetic — matches source channel's music | 9 |
| **Energetic dramatic** | Hype moments | 1 |

**Transitions are crisp** (often paired with a whoosh or fade) and aligned with **scene/niche boundaries**:
- New niche start → new track
- Switch from "proof" to "tips" within a niche → calmer track  
- CTA approaches → calm outro track

The viewer subconsciously reads the mood shift even before the new content arrives.

### B. Diegetic SFX mirroring — audio demonstrates what's being shown

When the narrator describes a content style or shows an action, **the audio plays that action** instead of just describing it:

| What's narrated/shown | What plays |
|---|---|
| "they use viral phonk music" | Phonk music actually plays during the demo (@51-59s, @102-114s) |
| "the sound of money counting" | Cash-counting SFX (@727s) |
| Cursor clicks on screen | Click SFX |
| Text appears on a card | Keyboard typing SFX |
| Money number appears ($6, $29,000) | Ding SFX exactly when the number lands |
| Stickman crashes in gameplay | Crash + squish + impact SFX |
| Troll-face meme appears | Troll-face laughter SFX |

This is the audio equivalent of visual System E (YouTube-native visual language) — **audio plays what's being shown**, not what's being described. It collapses the gap between description and demonstration.

### C. Music ducks under narration, full-volume on cuts

Industry standard but applied disciplined:
- "Background music fades slightly" when narrator speaks
- Music returns to full volume on visual cuts where narration pauses
- Music explicitly "fades out" at section boundaries before a new track fades in
- One track at a time — no cross-fading multiple beds

### D. Single male narrator, clear and measured delivery

One narrator throughout the entire video. Style notes from the corpus:
- "A male narrator speaks clearly" (~26 mentions)
- "Narrator's voice" / "Narrator's voice continues" (21 mentions)
- Calm/measured pacing, not high-energy hype
- Voice is the constant — music and SFX swap around it

For our generator: this maps to a single ElevenLabs voice (or equivalent) — male, calm/clear delivery, NOT the "high-energy YouTube vlogger" voice. Closer to a documentary narrator.

---

## The SFX primitive library (atomic sounds)

Stack-ranked by Money Groot usage:

### 1. Whoosh — primary transition SFX (43 uses)
**Use:** every visual element entry/exit, every text-card cut, between niches.
- "Subtle whoosh" — for soft entries (text appearing, slide-ins)
- "Sharp whoosh" — for hard cuts
- "Whoosh per item" — when each flag / element enters in a row
**Render:** standard whoosh SFX, ~200-400ms. ~3-5 different intensities/lengths for variety.

### 2. Ding — value-reveal SFX (5 uses)
**Use:** exactly when a NUMBER or VALUE appears on screen.
- "Ding sound effect as $6 appears" (@251s)
- "Ding sound effect as thumbnail appears" (@279s)
- "Distinct 'ding' as narrator says 'six'" (@396s — number reveal)
**Render:** soft bell-like chime, ~150ms. Pitched up for emphasis on bigger numbers.

### 3. Click — interaction SFX (5 uses)
**Use:** for cursor clicks, scrolling, navigation actions.
- "Click sound effect" (@244s, @273s, @281s)
**Render:** standard UI click, sharp ~50-80ms.

### 4. Keyboard typing — text-appearance SFX (4 uses)
**Use:** when text appears on screen (typewriter effect).
- "Sound of typing as text appears" (@262s)
- "Keyboard typing sounds" (@664s, @733s, @763s)
**Render:** rapid typewriter pattern, ~3-6 keystrokes per word.

### 5. Bell ring — punctuation (1 use)
**Use:** affirmation / notification moments.
**Render:** clear bell ring, ~400ms.

### 6. Page turn — section transition (1 use)
**Use:** major section boundaries (between major topical shifts).
**Render:** soft paper-turn sound, ~300ms.

### 7. Cash counting — money beat SFX (1 use)
**Use:** when referencing earnings totals or accumulating money.
**Render:** rapid cash-counting loop, 800ms-1.2s.

### 8. Soft chimes — magical/positive moments (1 use)
**Use:** for "the best part" / positive reveals.
**Render:** rising chime sequence, 400-600ms.

### 9. Mouse click — proof navigation (1 use)
**Use:** when actually demonstrating clicking through YouTube.
**Render:** identical to #3, just paired with cursor visual.

### 10. Ascending electronic sting — CTA outro punctuation (1 use)
**Use:** final beat of CTA before the music ends.
**Render:** short ascending tone, ~500ms.

---

## Niche-specific diegetic SFX (dynamic, not static library)

For the gameplay/stickman niche, Money Groot uses SFX matching the actual content shown:
- Crash, squish, impact, whistle, water bubbling, engine revving, troll-face laughter, clapping, shouting

**These shouldn't be pre-baked in our library.** They're **clipped from the source channels' actual videos** along with the visual clip. When we show a content clip in a rounded-rectangle frame, we keep the original audio (or grab matched SFX from a free library) to maintain the diegetic mirror.

For our generator: every per-niche content clip → use the source's native audio underneath, with the narrator's voice ducking the music briefly to let the diegetic SFX through.

---

## Music track switches mapped to script structure

Looking at WHERE Money Groot switches tracks reveals the rule:

| Time | Old track | New track | Why |
|---|---|---|---|
| 0s | (silence) | upbeat_light | Video starts |
| 51s | upbeat_light | **phonk_funk** | Entering gameplay-style demo (diegetic match) |
| 62s | phonk_funk | energetic_dramatic | Hype peak |
| 104s | energetic_dramatic | **phonk_funk** | Back to demonstration |
| 121s | phonk_funk | upbeat_light | Demo ends, back to narration |
| 241s | upbeat_light | upbeat_corporate | New niche (#4) — section pivot |
| 300s | upbeat_corporate | soft_calm | Personal tips section opens |
| 363s | soft_calm | calm_uplifting | Tips continue, slightly more energy |
| 421s | calm_uplifting | upbeat_motivational | Proof-heavy niche begins |
| 541s | upbeat_motivational | **upbeat_tech** | Niche #8 = AI game development (topic match) |
| 600s | upbeat_tech | upbeat_light | Niche transition |
| 661s | upbeat_light | upbeat_modern_inspirational | Niche #10/11 (data viz / horror — inspirational) |
| 722s | upbeat_modern_inspirational | upbeat_light | Wrap-up |
| 781s | upbeat_light | upbeat_calm | **CTA outro** |

### The rule

Track switches happen at one of three triggers:
1. **Section boundary** — new niche, new tips section, CTA
2. **Mode shift** — narration → demo → narration (proof modes vs commentary modes)
3. **Topic match** — niche topic suggests a specific mood (tech niche → tech-themed; inspirational niche → modern-inspirational; gameplay → phonk)

For the generator: every niche we generate has a `mood` field (default `upbeat_light`). Override per script section (tips → calm, CTA → calm). For high-affinity niches (tech / gaming / inspirational), the niche's `mood_override` field carries the genre-matched track.

---

## Production stack — what we need to build/license

### Music library (6 royalty-free tracks minimum, expandable)
1. **upbeat_light** — default narration baseline (~120 BPM, light electronic, no vocals)
2. **upbeat_motivational** — proof/inspiration (~125 BPM, uplifting, swelling)
3. **calm_uplifting** — tips / educational (~95 BPM, gentle, encouraging)
4. **upbeat_tech-themed** — tech niches (~125 BPM, electronic, synth-heavy)
5. **upbeat_calm** — CTA outro (~110 BPM, light, resolves cleanly)
6. **upbeat_corporate** — section pivots (~120 BPM, clean, neutral)

**Optional expansion (niche-specific):**
7. phonk / electronic-funk — for gameplay / hype niches
8. soft_calm — intimate moments / personal advice
9. upbeat_modern_inspirational — for inspirational niches

**Source:** NoCopyrightSounds (NCS), Epidemic Sound, Artlist, or YouTube Audio Library. ~$0 to ~$15/mo total licensing.

### SFX library (15 atomic assets)
- whoosh (×3 variants — subtle / sharp / per-item)
- ding (×2 variants — soft / strong)
- click
- keyboard typing loop
- bell ring
- page turn
- cash counting
- soft chimes (rising)
- mouse click
- ascending electronic sting
- generic impact
- generic crash (for diegetic moments)

**Source:** Free SFX from YouTube Audio Library, freesound.org, or paid pack from Envato (~$20 one-time).

### Voice
- Single ElevenLabs voice (or equivalent — Murf, PlayHT)
- Voice profile: male, calm/measured, clear articulation, mid-pitch
- ~$5-22/mo for ElevenLabs Starter, allowing ~30K characters/mo = several full videos

### Ducking
- Standard sidechain ducking — music drops ~6dB when narrator speaks, returns over ~200ms when narrator pauses
- One-time DAW template or FFmpeg filter graph

---

## Audio composition example (single niche reveal sequence)

Pairing this with the visual composition example from `visual-packaging-class-b.md`:

```
[Number 4 card] (white bg)             Music: upbeat_corporate
                                        SFX: whoosh on entry, ding on number
[Niche name card]                       Music: continues
                                        SFX: none
[YT channel page + yellow circle]       Music: continues (ducks for narrator)
                                        SFX: whoosh on page-load
[Shrug character + "$6 RPM" green]      Music: continues
                                        SFX: ding when $6 appears
[Most-popular video callout]            Music: continues
                                        SFX: ding when thumbnail lands
[Text card: "this would translate to"]  Music: continues
                                        SFX: subtle whoosh
[Text card: "$6,000" huge green]        Music: continues
                                        SFX: ding (pitched up — bigger number)
[Text card: "from ads"]                 Music: continues
                                        SFX: subtle whoosh
[Chalkboard: STORYTELLING]              Music: continues
                                        SFX: soft chime
[Cat thumbs-up + appreciation]          Music: ducks deeper for personal moment
                                        SFX: none
[End of niche]                          Music: fades out → new track for next niche
```

Audio carries continuity (music bed) while SFX provides per-element punctuation.

---

## What's NOT in Class B audio (excluded — Class A signals)

| Pattern | Reason excluded |
|---|---|
| Glitch SFX (heavy electronic distortion between sections) | Class A signature — overproduced for the indie-faceless aesthetic |
| Cinematic build-ups / orchestral swells | Brand-studio territory |
| Two voices / male+female narrator mix | Class A (InVideo style — has multiple narrators) |
| Energetic-vlogger high-pitch narration | Mismatched mood for educational/calm style |
| Hype "BANG" / explosion SFX on number reveals | Money Groot uses soft ding, not loud bangs |
| Multiple SFX stacked on single cut | One SFX per cut maximum (clean signal) |
| Continuous narrator-talking with no music gaps | Music is the constant; gaps are rare |
| Subscribe-button "ding" jingle | MG's CTA uses no audio cue — just a text card |

---

## Next checkpoints (queued)

1. `slot-rendering-class-b` — for each data-points.json slot, which visual primitive(s) AND which audio cues deliver it (now coupled with the visual+audio specs)
2. `script-skeleton-class-b` — the actual 6-beat per-niche script template tying it all together
3. `audio-sfx-class-a` — when we build the brand-studio template
4. `audio-sfx-class-c` — when we build Hindi listicle template
