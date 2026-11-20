# Oathbound audio (prototype)

Original folk-style audio for the prototype battle: sparse plucked and bowed strings, low frame drums and choir hums, all synthesized in code by `tools/audio/generate_audio.py`. No samples or outside recordings are used.

- `music/`: battle loop (57.6 s, 100 BPM, loops seamlessly), camp loop (37.9 s, 76 BPM, 3/4), victory and defeat stings (4.5 s).
- `sfx/`: 17 sounds for UI, selection, movement, attacks, abilities, the vow cycle and unit down.
- `audio_manifest.json`: keys, loop flags, suggested volumes and when to play each sound.

Every sound ships as `.ogg` (load first) with an `.mp3` fallback for older Safari. One format of everything is about 1.3 MB.

Browsers block audio until the first click, so start music from the title screen's Start button. Duck music by about 6 dB for 2 s under `vow_kept` and `vow_broken`.

To change a sound, edit its function in the generator and run `python tools/audio/generate_audio.py` (needs numpy, scipy and ffmpeg).
