#!/usr/bin/env python3
"""Cut the OG MG video into beat clips sorted into folders by beat type.

Reads docs/content-gen/mg-og-beat-spans.json (Gemini beat segmentation of
MG's transcript — see scripts/local/annotate-og-beats.mts) and cuts
clips/video_src/MG-OG.mp4 into clips/mg-beats/<beat_type>/
niche_NN__<Channel>__tNNNNN.N.mp4. Frame-accurate (re-encode). Idempotent.

  python3 scripts/local/cut-og-beats.py
"""
import json, subprocess, os, re

spans = json.load(open('docs/content-gen/mg-og-beat-spans.json'))['spans']
SRC = 'clips/video_src/MG-OG.mp4'
OUT = 'clips/mg-beats'
CHANNELS = {
  1: 'VES_STICK', 2: 'Callon', 3: 'Doodle_Digest', 4: 'TV_Junkie',
  5: 'Lessons_in_Meme_Culture', 6: 'Quizetta', 7: 'Im_Not_a_Robot',
  8: 'Minimunch', 9: 'ripshy_MrNightmare', 10: 'Horizon_Analytics', 11: 'Mr_Science',
}
made = {}
for sp in spans:
    dur = sp['e'] - sp['s']
    if dur < 0.3: continue
    m = re.match(r'niche_(\d+)_(.+)', sp['label'])
    if m:
        n, beat = int(m.group(1)), m.group(2)
        fname = f"niche_{n:02d}__{CHANNELS.get(n, f'niche{n}')}__t{sp['s']:07.1f}.mp4"
    else:
        beat, fname = sp['label'], f"video__t{sp['s']:07.1f}.mp4"
    d = os.path.join(OUT, beat); os.makedirs(d, exist_ok=True)
    out = os.path.join(d, fname)
    if not os.path.exists(out):
        subprocess.run(['ffmpeg', '-hide_banner', '-loglevel', 'error',
            '-ss', f"{sp['s']:.2f}", '-i', SRC, '-t', f"{dur:.2f}",
            '-c:v', 'libx264', '-crf', '21', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-y', out], check=True)
    made[beat] = made.get(beat, 0) + 1
print('clips:', sum(made.values()), 'folders:', len(made))
