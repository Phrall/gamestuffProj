"""Oathbound prototype audio generator.

Every sound and music cue in assets/audio is synthesized from scratch by this
script (no samples, no third-party recordings), so it is fully original and can
be re-tuned by editing the parameters below and re-running:

    python tools/audio/generate_audio.py

Requires numpy + scipy, and ffmpeg (libvorbis + libmp3lame) on PATH.
Writes WAV masters to tools/audio/masters/ (git-ignored) and shipped
OGG + MP3 files to assets/audio/sfx and assets/audio/music.
"""

import os
import subprocess
import wave

import numpy as np
from scipy.signal import butter, sosfilt

SR = 44100
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
MASTERS = os.path.join(ROOT, "tools", "audio", "masters")
OUT_SFX = os.path.join(ROOT, "assets", "audio", "sfx")
OUT_MUS = os.path.join(ROOT, "assets", "audio", "music")
RNG = np.random.default_rng(7)  # fixed seed so re-runs are reproducible


# ---------------------------------------------------------------- helpers

def t_axis(dur):
    return np.arange(int(dur * SR)) / SR


def midi_hz(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def env_adsr(n, a=0.01, d=0.1, s=0.7, r=0.2):
    a_n, d_n, r_n = int(a * SR), int(d * SR), int(r * SR)
    s_n = max(n - a_n - d_n - r_n, 0)
    e = np.concatenate([
        np.linspace(0, 1, a_n, endpoint=False),
        np.linspace(1, s, d_n, endpoint=False),
        np.full(s_n, s),
        np.linspace(s, 0, r_n),
    ])
    return np.pad(e, (0, max(n - len(e), 0)))[:n]


def env_exp(n, decay):
    return np.exp(-np.arange(n) / (decay * SR))


def lp(x, hz, order=2):
    return sosfilt(butter(order, min(hz, SR / 2 - 100), "low", fs=SR, output="sos"), x)


def hp(x, hz, order=2):
    return sosfilt(butter(order, hz, "high", fs=SR, output="sos"), x)


def bp(x, lo, hi, order=2):
    return sosfilt(butter(order, [lo, hi], "band", fs=SR, output="sos"), x)


def noise(n):
    return RNG.uniform(-1, 1, n)


def place(buf, sig, start_s):
    i = int(start_s * SR)
    if i >= len(buf):
        return
    j = min(len(buf), i + len(sig))
    buf[i:j] += sig[: j - i]


def reverb(x, wet=0.25, length=1.6, damp=3000):
    """Cheap convolution reverb with a synthetic decaying-noise impulse."""
    n = int(length * SR)
    ir = noise(n) * np.exp(-np.arange(n) / (length * SR / 5))
    ir = lp(ir, damp)
    ir /= np.sqrt(np.sum(ir ** 2)) + 1e-9
    from scipy.signal import fftconvolve
    if x.ndim == 1:
        w = fftconvolve(x, ir)[: len(x)]
    else:
        w = np.stack([fftconvolve(x[:, c], ir)[: len(x)] for c in range(x.shape[1])], 1)
    return x * (1 - wet) + w * wet


def normalize(x, peak_db=-3.0):
    p = np.max(np.abs(x)) + 1e-9
    return x / p * 10 ** (peak_db / 20)


def fade(x, fin=0.002, fout=0.01):
    x = x.copy()
    a, b = int(fin * SR), int(fout * SR)
    if a:
        x[:a] *= np.linspace(0, 1, a)[:, None] if x.ndim == 2 else np.linspace(0, 1, a)
    if b:
        x[-b:] *= np.linspace(1, 0, b)[:, None] if x.ndim == 2 else np.linspace(1, 0, b)
    return x


def write_wav(path, x):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    x = np.clip(x, -1, 1)
    ch = 1 if x.ndim == 1 else x.shape[1]
    with wave.open(path, "wb") as w:
        w.setnchannels(ch)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes((x * 32767).astype("<i2").tobytes())


def encode(name, x, out_dir, music=False):
    master = os.path.join(MASTERS, name + ".wav")
    write_wav(master, x)
    os.makedirs(out_dir, exist_ok=True)
    if music:
        ogg_q, mp3_b = "3", "96k"   # ~96 kbps stereo
    else:
        ogg_q, mp3_b = "2", "64k"   # mono SFX
    base = os.path.join(out_dir, name)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", master,
                    "-c:a", "libvorbis", "-q:a", ogg_q, base + ".ogg"], check=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", master,
                    "-c:a", "libmp3lame", "-b:a", mp3_b, base + ".mp3"], check=True)


# ---------------------------------------------------------- instruments

def pluck(freq, dur, bright=0.5, decay=0.996):
    """Karplus-Strong plucked string (lute / harp-like)."""
    n = int(dur * SR)
    p = max(int(SR / freq), 2)
    out = np.zeros(n)
    buf = lp(noise(p), 1500 + 6000 * bright, 1)
    out[:p] = buf
    i = p
    while i < n:
        j = min(i + p, n)
        prev = out[i - p:j - p]
        prev2 = out[i - p - 1:j - p - 1] if i - p - 1 >= 0 else np.concatenate([[0], out[i - p:j - p - 1]])
        out[i:j] = decay * 0.5 * (prev + prev2[: len(prev)])
        i = j
    return out * env_adsr(n, 0.001, 0.0, 1.0, 0.05)


def bowed(freq, dur, vib=5.2, depth=0.006, attack=0.25, cutoff=2600):
    """Bowed string (fiddle / viola): saw with vibrato, bow noise and body filter."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    vib_amt = depth * np.clip(t / 0.4, 0, 1)
    ph = 2 * np.pi * np.cumsum(freq * (1 + vib_amt * np.sin(2 * np.pi * vib * t))) / SR
    saw = sum(np.sin(k * ph) / k for k in range(1, 14))
    sig = lp(saw, cutoff) + 0.03 * bp(noise(n), 2000, 5000)
    sig = bp(sig, 180, 5000)
    return sig * env_adsr(n, attack, 0.2, 0.8, min(0.35, dur / 3))


def hum(freq, dur, attack=0.6, release=0.8, vowel="oo"):
    """Choir hum: few detuned voices, soft harmonics, slow vibrato."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    amps = {"oo": [1, 0.35, 0.12, 0.05, 0.02], "mm": [1, 0.5, 0.2, 0.1, 0.05],
            "ah": [1, 0.6, 0.45, 0.3, 0.2, 0.12]}[vowel]
    out = np.zeros(n)
    for v, det in enumerate([-0.004, 0.0, 0.0035]):
        f = freq * (1 + det)
        vib = 1 + 0.004 * np.sin(2 * np.pi * (4.6 + 0.4 * v) * t + v)
        ph = 2 * np.pi * np.cumsum(f * vib) / SR
        out += sum(a * np.sin((k + 1) * ph) for k, a in enumerate(amps))
    out = lp(out, 1800) + 0.004 * lp(noise(n), 1200)
    return out / 3 * env_adsr(n, attack, 0.3, 0.85, min(release, dur / 2))


def drum_low(dur=0.7, f0=95, f1=48, vel=1.0):
    """Frame drum / low tom: pitched-down sine body plus skin noise."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-t / 0.05)
    body = np.sin(2 * np.pi * np.cumsum(f) / SR) * env_exp(n, 0.22)
    skin = lp(noise(n), 900) * env_exp(n, 0.03) * 0.5
    return (body + skin) * vel


def drum_tap(dur=0.15, vel=0.5):
    """Hand tap on the drum rim."""
    n = int(dur * SR)
    return bp(noise(n), 400, 2500) * env_exp(n, 0.02) * vel


def shaker(dur=0.12, vel=0.25):
    n = int(dur * SR)
    return hp(noise(n), 5000) * env_adsr(n, 0.01, 0.03, 0.3, 0.06) * vel


def stereo(x, pan=0.0):
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    return np.stack([x * l, x * r], 1) * np.sqrt(2)


# ------------------------------------------------------------------ SFX

def sfx_ui_click():
    n = int(0.06 * SR)
    s = bp(noise(n), 1500, 4500) * env_exp(n, 0.006)
    s += np.sin(2 * np.pi * 1800 * t_axis(0.06)) * env_exp(n, 0.01) * 0.4
    return s


def sfx_ui_hover():
    n = int(0.05 * SR)
    return np.sin(2 * np.pi * 2600 * t_axis(0.05)) * env_exp(n, 0.008) * 0.5


def sfx_ui_back():
    t = t_axis(0.14)
    f = 900 * np.exp(-t * 6)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env_adsr(len(t), 0.002, 0.03, 0.5, 0.08)


def sfx_unit_select():
    # soft wooden knock + a quick two-note lute pluck (D, A)
    s = drum_tap(0.12, 0.6)
    p = np.zeros(int(0.45 * SR))
    place(p, pluck(midi_hz(62), 0.4, 0.6), 0.0)
    place(p, pluck(midi_hz(69), 0.35, 0.6) * 0.8, 0.06)
    place(p, s, 0)
    return p


def sfx_move_step(var):
    # footstep on packed earth / gravel
    n = int(0.16 * SR)
    thump = lp(noise(n), 250 + 40 * var) * env_exp(n, 0.025) * 1.2
    grit = bp(noise(n), 1500, 6000) * env_exp(n, 0.012 + 0.004 * var) * 0.35
    return thump + grit


def sfx_unit_move():
    # a short run of 3 steps, used once per move order
    out = np.zeros(int(0.7 * SR))
    for k, (ti, v) in enumerate([(0.0, 1.0), (0.22, 0.8), (0.44, 0.9)]):
        place(out, sfx_move_step(k) * v, ti)
    return out


def sfx_attack_hit(var):
    # blade/blunt impact: low thud + metallic clang + crunchy noise
    dur = 0.45
    n = int(dur * SR)
    t = t_axis(dur)
    thud = np.sin(2 * np.pi * np.cumsum(110 * np.exp(-t * 8) + 50) / SR) * env_exp(n, 0.08)
    clang_f = [1730, 2410, 3170][var]
    clang = sum(np.sin(2 * np.pi * clang_f * r * t) for r in (1, 1.51, 2.37)) * env_exp(n, 0.07) * 0.18
    crunch = bp(noise(n), 800, 4000) * env_exp(n, 0.03) * 0.8
    return thud + clang + crunch


def sfx_attack_miss():
    # blade whoosh: filtered noise sweep
    dur = 0.35
    n = int(dur * SR)
    x = noise(n)
    shape = np.sin(np.pi * np.arange(n) / n) ** 2
    low = bp(x, 400, 1400) * shape
    high = bp(x, 1800, 5000) * shape * np.sin(np.pi * np.arange(n) / n) ** 4  # brightest mid-swing
    return low + 0.8 * high


def sfx_bow_shot():
    # bowstring release (low twang) + arrow hiss
    dur = 0.4
    n = int(dur * SR)
    t = t_axis(dur)
    twang = np.sin(2 * np.pi * 140 * t + 2 * np.sin(2 * np.pi * 280 * t)) * env_exp(n, 0.05)
    hiss = hp(noise(n), 3000) * env_adsr(n, 0.02, 0.1, 0.4, 0.2) * 0.25
    return twang + hiss


def sfx_ability_cast():
    # Hedge Mage spell: rising shimmer of bell partials over an airy swell
    dur = 1.1
    n = int(dur * SR)
    out = np.zeros(n)
    for k, m in enumerate([74, 77, 81, 84, 88]):
        t = t_axis(dur - k * 0.08)
        bell = sum(np.sin(2 * np.pi * midi_hz(m) * r * t) * a for r, a in ((1, 1), (2.76, 0.3), (5.4, 0.1)))
        place(out, bell * env_exp(len(t), 0.35) * 0.25, k * 0.08)
    air = bp(noise(n), 2000, 8000) * env_adsr(n, 0.3, 0.2, 0.5, 0.5) * 0.15
    return reverb(out + air, 0.35, 1.2)


def sfx_ability_heal():
    # Pilgrim heal / oath magic: warm major hum + soft chime
    dur = 1.3
    out = sum(hum(midi_hz(m), dur, 0.25, 0.6, "oo") for m in (62, 66, 69)) * 0.5
    t = t_axis(dur)
    chime = np.sin(2 * np.pi * midi_hz(86) * t) * env_exp(len(t), 0.4) * 0.15
    return reverb(out + chime, 0.35, 1.5)


def sfx_vow_sworn():
    # a deep drum strike + low "mm" choir on the open fifth (D-A): solemn promise
    dur = 2.0
    out = np.zeros(int(dur * SR))
    place(out, drum_low(1.2, 80, 42, 1.0), 0)
    for m in (50, 57, 62):
        place(out, hum(midi_hz(m), 1.8, 0.15, 1.0, "mm") * 0.45, 0.02)
    return reverb(out, 0.3, 2.0)


def sfx_vow_kept():
    # SIGNATURE: warm swell, D major choir rising into a held chord + bright pluck
    dur = 3.0
    out = np.zeros(int(dur * SR))
    for k, m in enumerate([50, 57, 62, 66, 69, 74]):
        place(out, hum(midi_hz(m), 2.6 - k * 0.12, 0.9, 1.0, "ah") * (0.45 - k * 0.03), k * 0.12)
    for k, m in enumerate([74, 78, 81, 86]):
        place(out, pluck(midi_hz(m), 1.2, 0.7) * 0.35, 0.9 + k * 0.07)
    place(out, drum_low(1.2, 70, 40, 0.6), 0.85)
    return reverb(out, 0.4, 2.5, 4000)


def sfx_vow_broken():
    # SIGNATURE: glass crack + shatter tinkle over a dissonant low drop
    dur = 2.4
    n = int(dur * SR)
    out = np.zeros(n)
    # sharp crack transient
    cn = int(0.05 * SR)
    place(out, hp(noise(cn), 2500) * env_exp(cn, 0.006) * 1.6, 0)
    # resonant glass partials (inharmonic, decaying)
    t = t_axis(1.6)
    glass = sum(np.sin(2 * np.pi * f * t + RNG.uniform(0, 6)) * a
                for f, a in ((2310, 0.5), (3477, 0.4), (4890, 0.3), (6120, 0.2), (7790, 0.15)))
    place(out, glass * env_exp(len(t), 0.25) * 0.35, 0.005)
    # shards: many tiny random tinkles
    for _ in range(26):
        st = RNG.uniform(0.05, 0.9)
        f = RNG.uniform(3000, 9000)
        tt = t_axis(0.12)
        place(out, np.sin(2 * np.pi * f * tt) * env_exp(len(tt), 0.02) * RNG.uniform(0.05, 0.15), st)
    # dissonant low: tritone hum sliding down
    tt = t_axis(2.2)
    for f0 in (midi_hz(50), midi_hz(56)):
        f = f0 * (1 - 0.06 * tt / 2.2)
        low = np.sin(2 * np.pi * np.cumsum(f) / SR) + 0.3 * np.sin(4 * np.pi * np.cumsum(f) / SR)
        place(out, lp(low, 900) * env_adsr(len(tt), 0.05, 0.3, 0.6, 1.2) * 0.3, 0.03)
    return reverb(out, 0.3, 1.8, 6000)


def sfx_unit_down():
    # body hits the ground + a falling low string note
    dur = 1.6
    out = np.zeros(int(dur * SR))
    place(out, drum_low(0.6, 70, 35, 0.9), 0)
    place(out, lp(noise(int(0.25 * SR)), 400) * env_exp(int(0.25 * SR), 0.05) * 0.6, 0.0)
    tt = t_axis(1.4)
    f = midi_hz(57) * (1 - 0.12 * tt / 1.4)
    ph = 2 * np.pi * np.cumsum(f) / SR
    s = lp(sum(np.sin(k * ph) / k for k in range(1, 8)), 1400) * env_adsr(len(tt), 0.05, 0.3, 0.6, 0.8)
    place(out, s * 0.35, 0.1)
    return reverb(out, 0.3, 1.6)


# ----------------------------------------------------------------- MUSIC
# Original compositions written for Oathbound. Key centre D (dorian/minor for
# battle, major/mixolydian for camp). Folk palette: plucked strings, bowed
# fiddle/viola, low frame drums, choir hums.

def render_loop(length_s, fill, tail_s=3.0):
    """Render a loop with a tail, then fold the tail back to the start so the
    file loops seamlessly (reverb and ringing notes carry across the seam)."""
    n = int(length_s * SR)
    buf = np.zeros((n + int(tail_s * SR), 2))
    fill(buf)
    buf = reverb(buf, 0.22, 2.2, 3500)
    out = buf[:n].copy()
    out[: len(buf) - n] += buf[n:]
    return out


def battle_loop():
    bpm = 100
    beat = 60 / bpm
    bars = 24
    length = bars * 4 * beat  # 57.6 s

    # chord roots per bar (4-bar cycle): Dm  C  Bb  A  (i  bVII  bVI  V) in dorian/aeolian colour
    prog = [(50, [62, 65, 69]), (48, [60, 64, 67]), (46, [58, 62, 65]), (45, [57, 61, 64])]
    # original fiddle melody (midi, start beat, length beats), 8 bars, played twice
    mel = [(74, 0, 1.5), (72, 1.5, 0.5), (69, 2, 2),
           (67, 4, 1), (69, 5, 1), (72, 6, 2),
           (70, 8, 1.5), (69, 9.5, 0.5), (65, 10, 1), (67, 11, 1),
           (69, 12, 3), (64, 15, 1),
           (65, 16, 1), (67, 17, 1), (69, 18, 1.5), (72, 19.5, 0.5),
           (74, 20, 2), (72, 22, 1), (69, 23, 1),
           (70, 24, 1), (69, 25, 1), (67, 26, 1), (65, 27, 1),
           (64, 28, 2), (61, 30, 1), (62, 31, 1)]

    def fill(buf):
        for bar in range(bars):
            b0 = bar * 4 * beat
            root, chord = prog[bar % 4]
            # low drums: driving "march" pattern, busier in the second half
            place(buf, stereo(drum_low(0.8, 95, 46, 1.0), -0.1), b0)
            place(buf, stereo(drum_low(0.6, 90, 50, 0.55), 0.1), b0 + 1.5 * beat)
            place(buf, stereo(drum_low(0.8, 95, 46, 0.85), -0.1), b0 + 2 * beat)
            if bar >= 8:
                place(buf, stereo(drum_low(0.5, 100, 55, 0.45), 0.15), b0 + 3.5 * beat)
            for k in range(8):
                if bar >= 4:
                    place(buf, stereo(drum_tap(0.12, 0.18 if k % 2 else 0.28), 0.4), b0 + k * 0.5 * beat)
            # plucked ostinato (lute): root-fifth-octave pattern in 8ths
            pat = [root + 12, chord[2], chord[0] + 12, chord[2], root + 12, chord[1] + 12, chord[2], chord[1]]
            for k, m in enumerate(pat):
                place(buf, stereo(pluck(midi_hz(m), 0.9, 0.45) * 0.32, 0.3), b0 + k * 0.5 * beat)
            # bass drone (viola, sustained root)
            place(buf, stereo(bowed(midi_hz(root), 4 * beat + 0.3, attack=0.4, cutoff=1200) * 0.22, -0.2), b0)
            # choir hum enters at bar 9
            if bar >= 8:
                for j, m in enumerate(chord):
                    place(buf, stereo(hum(midi_hz(m - 12 if j == 0 else m), 4 * beat + 0.4, 0.8, 0.8, "mm") * 0.16,
                                      -0.4 + 0.4 * j), b0)
        # fiddle melody at bars 9-16 and 17-24 (second time an octave-doubled hum joins)
        for rep, start_bar in enumerate((8, 16)):
            for m, sb, lb in mel:
                st = (start_bar * 4 + sb) * beat
                place(buf, stereo(bowed(midi_hz(m), lb * beat + 0.15, attack=0.06) * 0.2, 0.15), st)
                if rep == 1:
                    place(buf, stereo(hum(midi_hz(m - 12), lb * beat + 0.2, 0.08, 0.2, "oo") * 0.1, -0.15), st)

    return render_loop(length, fill)


def camp_loop():
    bpm = 76
    beat = 60 / bpm
    bars = 16  # 3/4 time
    length = bars * 3 * beat  # ~37.9 s

    # D  G/D  A  D | Bm  G  A  D   (warm, resting)
    prog = [(50, [62, 66, 69]), (50, [62, 67, 71]), (45, [61, 64, 69]), (50, [62, 66, 69]),
            (47, [62, 66, 71]), (43, [62, 67, 71]), (45, [61, 64, 69]), (50, [62, 66, 69])]
    # gentle original tune (midi, start beat, len) over 8 bars of 3/4
    mel = [(78, 0, 2), (76, 2, 1), (74, 3, 3),
           (71, 6, 1), (74, 7, 1), (76, 8, 1), (73, 9, 3),
           (74, 12, 2), (78, 14, 1), (76, 15, 2), (74, 17, 1),
           (73, 18, 1.5), (71, 19.5, 0.5), (69, 20, 1), (74, 21, 3)]

    def fill(buf):
        for bar in range(bars):
            b0 = bar * 3 * beat
            root, chord = prog[bar % 8]
            # harp-like arpeggio in 8ths
            arp = [root + 12, chord[0], chord[1], chord[2], chord[1], chord[0]]
            for k, m in enumerate(arp):
                place(buf, stereo(pluck(midi_hz(m), 1.4, 0.3, 0.998) * 0.3, -0.25 + 0.1 * (k % 3)), b0 + k * 0.5 * beat)
            # soft hum pad
            for j, m in enumerate(chord):
                place(buf, stereo(hum(midi_hz(m - 12), 3 * beat + 0.6, 1.0, 1.0, "oo") * 0.11, -0.3 + 0.3 * j), b0)
            # quiet hand-drum heartbeat on beat 1
            place(buf, stereo(drum_low(0.6, 80, 50, 0.35), 0), b0)
            if bar % 2:
                place(buf, stereo(shaker(0.15, 0.08), 0.5), b0 + 2 * beat)
        # melody second half only (bars 9-16), on a soft fiddle
        for m, sb, lb in mel:
            place(buf, stereo(bowed(midi_hz(m), lb * beat + 0.2, vib=4.8, attack=0.12, cutoff=2000) * 0.15, 0.2),
                  (8 * 3 + sb) * beat)

    return render_loop(length, fill)


def victory_sting():
    dur = 4.5
    buf = np.zeros((int(dur * SR), 2))
    beat = 0.3
    # drum pickup
    for k, v in enumerate([0.5, 0.6, 0.75, 1.0]):
        place(buf, stereo(drum_low(0.6, 100, 50, v), 0), k * beat * 0.5)
    t0 = 2 * beat
    # rising pluck line then D major choir chord
    for k, m in enumerate([62, 66, 69, 74]):
        place(buf, stereo(pluck(midi_hz(m), 1.5, 0.7) * 0.4, 0.2), t0 - 0.6 + k * 0.15)
    for j, m in enumerate([50, 57, 62, 66, 69, 74, 78]):
        place(buf, stereo(hum(midi_hz(m), 3.2, 0.12, 1.4, "ah") * 0.2, -0.5 + j / 6), t0)
    place(buf, stereo(bowed(midi_hz(74), 3.0, attack=0.08) * 0.22, 0.1), t0)
    place(buf, stereo(drum_low(1.4, 80, 40, 1.0), 0), t0)
    return fade(reverb(buf, 0.3, 2.5), 0.001, 0.4)


def defeat_sting():
    dur = 4.5
    buf = np.zeros((int(dur * SR), 2))
    for k, m in enumerate([69, 65, 62, 61]):
        place(buf, stereo(bowed(midi_hz(m), 1.2 if k < 3 else 2.8, attack=0.1, cutoff=1600) * 0.25, 0.1), k * 0.55)
    for j, m in enumerate([38, 50, 53, 57]):
        place(buf, stereo(hum(midi_hz(m), 3.8, 0.4, 1.6, "mm") * 0.17, -0.3 + 0.2 * j), 0.6)
    place(buf, stereo(drum_low(1.5, 60, 32, 0.9), 0), 0)
    place(buf, stereo(drum_low(1.5, 55, 30, 0.7), 0), 1.65)
    return fade(reverb(buf, 0.35, 2.5), 0.001, 0.5)


# ------------------------------------------------------------------ main

def main():
    sfx = {
        "ui_click": sfx_ui_click(),
        "ui_hover": sfx_ui_hover(),
        "ui_back": sfx_ui_back(),
        "unit_select": sfx_unit_select(),
        "unit_move": sfx_unit_move(),
        "atk_hit_01": sfx_attack_hit(0),
        "atk_hit_02": sfx_attack_hit(1),
        "atk_hit_03": sfx_attack_hit(2),
        "atk_miss": sfx_attack_miss(),
        "atk_bow": sfx_bow_shot(),
        "ability_cast": sfx_ability_cast(),
        "ability_heal": sfx_ability_heal(),
        "vow_sworn": sfx_vow_sworn(),
        "vow_kept": sfx_vow_kept(),
        "vow_broken": sfx_vow_broken(),
        "unit_down": sfx_unit_down(),
    }
    peaks = {"ui_hover": -12, "ui_click": -8, "ui_back": -8, "unit_move": -5,
             "vow_kept": -2, "vow_broken": -2, "vow_sworn": -3}
    for name, x in sfx.items():
        encode(name, fade(normalize(x, peaks.get(name, -4))), OUT_SFX)
        print("sfx", name, f"{len(x) / SR:.2f}s")

    music = {
        "mus_battle_loop": (battle_loop(), False),
        "mus_camp_loop": (camp_loop(), False),
        "mus_victory_sting": (victory_sting(), True),
        "mus_defeat_sting": (defeat_sting(), True),
    }
    for name, (x, sting) in music.items():
        x = normalize(x, -1.5)
        encode(name, x, OUT_MUS, music=True)
        print("music", name, f"{len(x) / SR:.1f}s")


if __name__ == "__main__":
    main()
