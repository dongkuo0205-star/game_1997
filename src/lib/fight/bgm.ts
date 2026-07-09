// ============================================================================
// Procedural chiptune battle BGM — an ORIGINAL minor-pentatonic loop composed
// for this game (no existing melodies), synthesized live with Web Audio.
// Runs on the same lazily-unlocked AudioContext policy as sfx.ts.
// ============================================================================

let audioCtx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let schedulerId: ReturnType<typeof setInterval> | null = null;
let nextBarTime = 0;
let barIndex = 0;

const BPM = 132;
const BEAT = 60 / BPM;
const BAR = BEAT * 4;
const VOLUME = 0.045;

// A-minor pentatonic pool (Hz): A2 E3 G3 A3 C4 D4 E4 G4 A4
const BASS_NOTES = [110, 110, 82.41, 98]; // A2 A2 E2 G2 — one root note per bar
// 8-bar lead pattern; each entry is [semitone-step frequency, eighth-note slot].
// Composed by ear for this project: rising question phrase, falling answer.
const LEAD_PATTERN: Array<Array<[number, number]>> = [
  [[220, 0], [261.6, 2], [293.7, 4], [329.6, 6]],
  [[392, 0], [329.6, 3], [293.7, 5]],
  [[261.6, 0], [293.7, 2], [329.6, 4], [261.6, 6]],
  [[220, 0], [196, 4]],
  [[220, 0], [261.6, 2], [293.7, 4], [392, 6]],
  [[440, 0], [392, 3], [329.6, 5]],
  [[293.7, 0], [329.6, 2], [293.7, 4], [261.6, 6]],
  [[220, 0], [220, 4]],
];

function ensureContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!audioCtx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
  }
  if (audioCtx.state === "suspended") void audioCtx.resume();
  return audioCtx;
}

function note(ac: AudioContext, type: OscillatorType, freq: number, t: number, dur: number, gainScale: number) {
  if (!masterGain) return;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(gainScale, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(gain).connect(masterGain);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function hat(ac: AudioContext, t: number) {
  if (!masterGain) return;
  const frames = Math.floor(ac.sampleRate * 0.03);
  const buffer = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = 6000;
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.35, t);
  gain.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
  src.connect(filter).connect(gain).connect(masterGain);
  src.start(t);
}

function scheduleBar(ac: AudioContext, t: number, bar: number) {
  // bass: root eighth-note pulse
  const bass = BASS_NOTES[bar % BASS_NOTES.length];
  for (let i = 0; i < 8; i++) {
    note(ac, "triangle", bass, t + (BAR / 8) * i, BAR / 8 - 0.02, i % 2 === 0 ? 1 : 0.55);
  }
  // hats on off-beats
  for (let i = 1; i < 8; i += 2) hat(ac, t + (BAR / 8) * i);
  // lead
  for (const [freq, slot] of LEAD_PATTERN[bar % LEAD_PATTERN.length]) {
    note(ac, "square", freq, t + (BAR / 8) * slot, BEAT * 0.7, 0.5);
  }
}

export function startBgm(): void {
  const ac = ensureContext();
  if (!ac || schedulerId !== null) return;
  if (!masterGain) {
    masterGain = ac.createGain();
    masterGain.gain.value = VOLUME;
    masterGain.connect(ac.destination);
  }
  nextBarTime = ac.currentTime + 0.05;
  barIndex = 0;
  schedulerId = setInterval(() => {
    if (!ac) return;
    // keep ~2 bars scheduled ahead
    while (nextBarTime < ac.currentTime + BAR * 2) {
      scheduleBar(ac, nextBarTime, barIndex);
      nextBarTime += BAR;
      barIndex += 1;
    }
  }, 250);
}

export function stopBgm(): void {
  if (schedulerId !== null) {
    clearInterval(schedulerId);
    schedulerId = null;
  }
  // fade out anything already scheduled
  if (audioCtx && masterGain) {
    masterGain.gain.cancelScheduledValues(audioCtx.currentTime);
    masterGain.gain.setValueAtTime(masterGain.gain.value, audioCtx.currentTime);
    masterGain.gain.linearRampToValueAtTime(0, audioCtx.currentTime + 0.4);
    const old = masterGain;
    setTimeout(() => {
      old.disconnect();
    }, 600);
    masterGain = null;
  }
}
