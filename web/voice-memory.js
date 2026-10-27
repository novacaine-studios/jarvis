// What Jarvis has learned about how the user speaks, kept on this phone (localStorage) only:
// - word fixes from the user's corrections ("is ate" -> "is it"), applied to everything Jarvis hears;
// - extra ways "Jarvis" gets misheard, so they wake him too;
// - voice recordings (as sound features) of corrected phrases and of the user saying "Jarvis".

const KEY = "jarvis-voice";
const MAX_FIXES = 200;
const MAX_PHRASES = 40;
const MAX_WAKES = 8;

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved) return { fixes: [], soundalikes: [], templates: [], ...saved };
  } catch {}
  return { fixes: [], soundalikes: [], templates: [] };
}

export const memory = load();

function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(memory));
  } catch {
    // Storage full: forget the oldest recordings and try again.
    memory.templates.splice(0, Math.ceil(memory.templates.length / 4));
    try {
      localStorage.setItem(KEY, JSON.stringify(memory));
    } catch {}
  }
}

const words = (text) => text.split(/\s+/).filter(Boolean);
const plain = (word) => word.toLowerCase().replace(/[^a-z0-9']/g, "");

/** Word-level differences between what was heard and what was meant. */
function differences(heard, meant) {
  const a = words(heard);
  const b = words(meant);
  const pa = a.map(plain);
  const pb = b.map(plain);
  // Longest common subsequence table.
  const lcs = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] = pa[i] === pb[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const hunks = [];
  let i = 0;
  let j = 0;
  let hunk = null;
  const close = () => {
    if (hunk) hunks.push({ ...hunk, after: i < a.length ? a[i] : null });
    hunk = null;
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && pa[i] === pb[j]) {
      close();
      i++;
      j++;
    } else {
      hunk ??= { from: [], to: [], before: i > 0 ? a[i - 1] : null };
      if (j < b.length && (i === a.length || lcs[i][j + 1] >= lcs[i + 1][j])) hunk.to.push(b[j++]);
      else hunk.from.push(a[i++]);
    }
  }
  close();
  return hunks;
}

/** Remembers a correction: `heard` is what Jarvis wrote down, `meant` is what the user actually said. */
export function learnCorrection(heard, meant) {
  for (const hunk of differences(heard, meant)) {
    // "Harvest what's" corrected to "Jarvis what is": the first word was "Jarvis" misheard.
    if (plain(hunk.to[0] ?? "") === "jarvis" && hunk.from.length > 1 && hunk.to.length > 1) {
      const soundalike = plain(hunk.from.shift());
      hunk.to.shift();
      if (soundalike && !memory.soundalikes.includes(soundalike)) memory.soundalikes.push(soundalike);
      hunk.before = null;
    }
    const to = hunk.to.map(plain).join(" ");
    const from = hunk.from.map(plain).filter(Boolean);
    // "Javis" or "jar vis" corrected to "Jarvis": wake up to that from now on.
    if (to === "jarvis" && from.length && from.length <= 2) {
      const soundalike = from.join("");
      if (!memory.soundalikes.includes(soundalike)) memory.soundalikes.push(soundalike);
      continue;
    }
    // Keep a neighbouring word with the fix, so "ate" is only changed to "it" after "is".
    let fromText;
    let toText;
    if (hunk.before) {
      fromText = [hunk.before, ...hunk.from];
      toText = [hunk.before, ...hunk.to];
    } else if (hunk.after) {
      fromText = [...hunk.from, hunk.after];
      toText = [...hunk.to, hunk.after];
    } else {
      fromText = hunk.from;
      toText = hunk.to;
    }
    fromText = fromText.map(plain).filter(Boolean);
    toText = toText.join(" ").replace(/^[\s,.!?]+|[\s,.!?]+$/g, "");
    if (!fromText.length) continue;
    memory.fixes = memory.fixes.filter((f) => f.from.join(" ") !== fromText.join(" "));
    memory.fixes.push({ from: fromText, to: toText });
  }
  memory.fixes = memory.fixes.slice(-MAX_FIXES);
  save();
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Applies the user's past corrections to something Jarvis just heard. */
export function correct(text) {
  // Longer fixes first, so the most specific one wins.
  const fixes = [...memory.fixes].sort((x, y) => y.from.length - x.from.length);
  for (const fix of fixes) {
    const pattern = new RegExp(`(^|[^a-z0-9'])${fix.from.map(escape).join("[^a-z0-9']+")}(?=$|[^a-z0-9'])`, "gi");
    text = text.replace(pattern, (_, lead) => lead + fix.to);
  }
  return text;
}

export function addTemplate(template) {
  memory.templates.push(template);
  const of = (kind) => memory.templates.filter((t) => t.kind === kind);
  memory.templates = [...of("wake").slice(-MAX_WAKES), ...of("phrase").slice(-MAX_PHRASES)];
  save();
}

export function forgetVoice() {
  memory.fixes = [];
  memory.soundalikes = [];
  memory.templates = [];
  save();
}

export const knowsMyVoice = () => memory.templates.some((t) => t.kind === "wake");
