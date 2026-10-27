// Recognises the user's own voice by how it sounds, not by words: each saved recording is turned into
// MFCC features (the shape of the voice's frequencies over time), and new speech is compared against
// them with dynamic time warping, which allows for saying something faster or slower than before.
// Features are normalised per recording, so a whisper or a far-away voice still lines up with a normal one.

const RATE = 16000;
const FRAME = 400; // 25 ms
const HOP = 160; // 10 ms
const FFT = 512;
const MELS = 26;
export const DIMS = 12; // cepstral coefficients 1..12 (0 is loudness, which we ignore)

const hamming = Float32Array.from({ length: FRAME }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));

const melFilters = (() => {
  const mel = (f) => 2595 * Math.log10(1 + f / 700);
  const hz = (m) => 700 * (10 ** (m / 2595) - 1);
  const lo = mel(60);
  const hi = mel(7600);
  const bins = Array.from({ length: MELS + 2 }, (_, i) => Math.floor(((FFT + 1) * hz(lo + ((hi - lo) * i) / (MELS + 1))) / RATE));
  return Array.from({ length: MELS }, (_, m) => {
    const weights = new Float32Array(FFT / 2 + 1);
    for (let k = bins[m]; k < bins[m + 1]; k++) weights[k] = (k - bins[m]) / Math.max(1, bins[m + 1] - bins[m]);
    for (let k = bins[m + 1]; k < bins[m + 2]; k++) weights[k] = (bins[m + 2] - k) / Math.max(1, bins[m + 2] - bins[m + 1]);
    return weights;
  });
})();

const dct = Array.from({ length: DIMS }, (_, c) =>
  Float32Array.from({ length: MELS }, (_, m) => Math.sqrt(2 / MELS) * Math.cos((Math.PI * (c + 1) * (m + 0.5)) / MELS)),
);

function powerSpectrum(frame) {
  // Plain radix-2 FFT on a zero-padded frame.
  const re = new Float64Array(FFT);
  const im = new Float64Array(FFT);
  re.set(frame);
  for (let i = 1, j = 0; i < FFT; i++) {
    let bit = FFT >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j]] = [re[j], re[i]];
  }
  for (let len = 2; len <= FFT; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    for (let i = 0; i < FFT; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(angle * k);
        const wi = Math.sin(angle * k);
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  const power = new Float64Array(FFT / 2 + 1);
  for (let k = 0; k <= FFT / 2; k++) power[k] = re[k] * re[k] + im[k] * im[k];
  return power;
}

/** 16 kHz audio -> { frames, data } with DIMS numbers per 10 ms frame, silence at the ends trimmed. */
export function features(audio) {
  const count = Math.max(0, Math.floor((audio.length - FRAME) / HOP) + 1);
  const raw = [];
  const energy = [];
  const frame = new Float32Array(FRAME);
  for (let f = 0; f < count; f++) {
    let e = 0;
    for (let i = 0; i < FRAME; i++) {
      const s = audio[f * HOP + i] - 0.97 * (audio[f * HOP + i - 1] ?? 0);
      frame[i] = s * hamming[i];
      e += s * s;
    }
    energy.push(Math.log(e + 1e-10));
    const power = powerSpectrum(frame);
    const logMel = melFilters.map((w) => {
      let sum = 0;
      for (let k = 0; k < w.length; k++) sum += w[k] * power[k];
      return Math.log(sum + 1e-10);
    });
    raw.push(dct.map((row) => row.reduce((sum, v, m) => sum + v * logMel[m], 0)));
  }
  // Trim the quiet ends: anything closer to the background noise than to the loudest sound.
  // Relative levels, so it works the same for a whisper as for a shout.
  const sorted = [...energy].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? 0;
  const peak = sorted[sorted.length - 1] ?? 0;
  const threshold = Math.max(peak - 7, floor + 0.3 * (peak - floor));
  let start = 0;
  let end = raw.length;
  while (start < end && energy[start] < threshold) start++;
  while (end > start && energy[end - 1] < threshold) end--;
  const kept = raw.slice(start, end);
  const frames = kept.length;
  const data = new Float32Array(frames * DIMS);
  // Normalise each coefficient to zero mean and unit variance across the recording.
  for (let d = 0; d < DIMS; d++) {
    let mean = 0;
    for (const row of kept) mean += row[d];
    mean /= frames || 1;
    let variance = 0;
    for (const row of kept) variance += (row[d] - mean) ** 2;
    const sd = Math.sqrt(variance / (frames || 1)) || 1;
    for (let f = 0; f < frames; f++) data[f * DIMS + d] = (kept[f][d] - mean) / sd;
  }
  return { frames, data };
}

function cost(a, i, b, j) {
  let sum = 0;
  for (let d = 0; d < DIMS; d++) {
    const diff = a.data[i * DIMS + d] - b.data[j * DIMS + d];
    sum += diff * diff;
  }
  return Math.sqrt(sum / DIMS);
}

/**
 * Average per-step distance of the best alignment of `template` with `speech`.
 * With `anywhere`, the template may match any stretch of the speech (to spot "Jarvis" inside a sentence);
 * returns { distance, end } where end is the fraction of the speech where the match finished.
 */
export function compare(template, speech, { anywhere = false } = {}) {
  const n = template.frames;
  const m = speech.frames;
  if (!n || !m) return { distance: Infinity, end: 0 };
  let prevCost = new Float64Array(m);
  let prevLen = new Float64Array(m);
  let curCost = new Float64Array(m);
  let curLen = new Float64Array(m);
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      const c = cost(template, i, speech, j);
      let best;
      let len;
      if (i === 0 && (anywhere || j === 0)) {
        best = 0;
        len = 0;
      } else {
        best = Infinity;
        len = 0;
        const options = [
          i > 0 && j > 0 ? [prevCost[j - 1], prevLen[j - 1]] : null,
          i > 0 ? [prevCost[j], prevLen[j]] : null,
          j > 0 ? [curCost[j - 1], curLen[j - 1]] : null,
        ];
        for (const option of options) {
          if (!option) continue;
          const [oc, ol] = option;
          if (oc / Math.max(ol, 1) < best / Math.max(len, 1) || best === Infinity) {
            best = oc;
            len = ol;
          }
        }
      }
      curCost[j] = best + c;
      curLen[j] = len + 1;
    }
    [prevCost, curCost] = [curCost, prevCost];
    [prevLen, curLen] = [curLen, prevLen];
  }
  if (!anywhere) return { distance: prevCost[m - 1] / prevLen[m - 1], end: 1 };
  let distance = Infinity;
  let end = 0;
  for (let j = 0; j < m; j++) {
    const d = prevCost[j] / prevLen[j];
    if (d < distance) {
      distance = d;
      end = (j + 1) / m;
    }
  }
  return { distance, end };
}

export function encode({ frames, data }) {
  const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { frames, data: btoa(binary) };
}

export function decode({ frames, data }) {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return { frames, data: new Float32Array(bytes.buffer) };
}
