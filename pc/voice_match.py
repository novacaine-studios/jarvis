"""Recognises the user's own voice by how it sounds, not by words (the PC twin of web/voice-match.js).

Each saved recording becomes MFCC features (the shape of the voice's frequencies over time), and new
speech is compared with dynamic time warping, which allows for saying something faster or slower.
Features are normalised per recording, so a whisper or a far-away voice lines up with a normal one.
The feature format matches web/voice-match.js, so recordings learned by either side can be shared.
"""
import base64

import numpy as np

RATE = 16000
FRAME = 400  # 25 ms
HOP = 160  # 10 ms
FFT = 512
MELS = 26
DIMS = 12  # cepstral coefficients 1..12 (0 is loudness, which we ignore)


def _mel_filters():
    def mel(f):
        return 2595 * np.log10(1 + f / 700)

    def hz(m):
        return 700 * (10 ** (m / 2595) - 1)

    lo, hi = mel(60), mel(7600)
    bins = np.floor((FFT + 1) * hz(lo + (hi - lo) * np.arange(MELS + 2) / (MELS + 1)) / RATE).astype(int)
    filters = np.zeros((MELS, FFT // 2 + 1))
    for m in range(MELS):
        a, b, c = bins[m], bins[m + 1], bins[m + 2]
        for k in range(a, b):
            filters[m, k] = (k - a) / max(1, b - a)
        for k in range(b, c):
            filters[m, k] = (c - k) / max(1, c - b)
    return filters


_HAMMING = 0.54 - 0.46 * np.cos(2 * np.pi * np.arange(FRAME) / (FRAME - 1))
_MEL = _mel_filters()
_DCT = np.array([[np.sqrt(2 / MELS) * np.cos(np.pi * (c + 1) * (m + 0.5) / MELS) for m in range(MELS)] for c in range(DIMS)])


def features(audio):
    """16 kHz float audio -> (frames, DIMS) array, with the quiet ends trimmed."""
    audio = np.asarray(audio, dtype=np.float64)
    count = max(0, (len(audio) - FRAME) // HOP + 1)
    if count == 0:
        return np.zeros((0, DIMS), dtype=np.float32)
    emphasised = audio - 0.97 * np.concatenate([[0.0], audio[:-1]])
    index = np.arange(FRAME)[None, :] + HOP * np.arange(count)[:, None]
    frames = emphasised[index]
    energy = np.log((frames**2).sum(axis=1) + 1e-10)
    power = np.abs(np.fft.rfft(frames * _HAMMING, FFT)) ** 2
    cepstra = np.log(power @ _MEL.T + 1e-10) @ _DCT.T
    # Trim the quiet ends: anything closer to the background noise than to the loudest sound.
    ordered = np.sort(energy)
    floor, peak = ordered[int(len(ordered) * 0.1)], ordered[-1]
    loud = np.nonzero(energy >= max(peak - 7, floor + 0.3 * (peak - floor)))[0]
    kept = cepstra[loud[0] : loud[-1] + 1]
    sd = kept.std(axis=0)
    sd[sd == 0] = 1
    return ((kept - kept.mean(axis=0)) / sd).astype(np.float32)


def compare(template, speech, anywhere=False):
    """Average distance per template frame of the best alignment; with anywhere=True the template may
    match any stretch of the speech. Returns (distance, end) where end is the fraction of the speech
    at which the match finished."""
    n, m = len(template), len(speech)
    if n == 0 or m == 0:
        return float("inf"), 0.0
    diff = template[:, None, :] - speech[None, :, :]
    cost = np.sqrt((diff**2).mean(axis=2))
    # Each template frame lines up with the same, the next, or the one after next speech frame,
    # so a row only depends on the row before it and can be computed in one go.
    row = cost[0].copy() if anywhere else np.where(np.arange(m) == 0, cost[0, 0], np.inf)
    for i in range(1, n):
        best = row.copy()
        best[1:] = np.minimum(best[1:], row[:-1])
        best[2:] = np.minimum(best[2:], row[:-2])
        row = best + cost[i]
    if not anywhere:
        return float(row[-1] / n), 1.0
    j = int(np.argmin(row))
    return float(row[j] / n), (j + 1) / m


def encode(feats):
    return {"frames": int(len(feats)), "data": base64.b64encode(feats.astype("<f4").tobytes()).decode()}


def decode(saved):
    data = np.frombuffer(base64.b64decode(saved["data"]), dtype="<f4")
    return data.reshape(int(saved["frames"]), DIMS)
