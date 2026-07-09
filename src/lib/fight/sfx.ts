// ============================================================================
// Tiny procedural retro SFX synth (Web Audio API) — no audio assets needed.
// The AudioContext can only start after a user gesture, so unlock() is called
// from the keydown handler in FightCanvas.
// ============================================================================

let audioCtx: AudioContext | null = null;
let unlocked = false;

export function unlock(): void {
  if (typeof window === "undefined") return;
  if (!audioCtx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audioCtx = new Ctor();
  }
  if (audioCtx.state === "suspended") void audioCtx.resume();
  unlocked = true;
}

function ctx(): AudioContext | null {
  return unlocked && audioCtx && audioCtx.state === "running" ? audioCtx : null;
}

const MASTER_GAIN = 0.14;

function tone(
  type: OscillatorType,
  startFreq: number,
  endFreq: number,
  duration: number,
  gainScale = 1,
  delay = 0
): void {
  const ac = ctx();
  if (!ac) return;
  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(startFreq, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t0 + duration);
  gain.gain.setValueAtTime(MASTER_GAIN * gainScale, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

function noiseBurst(duration: number, gainScale = 1, lowpassHz = 1200): void {
  const ac = ctx();
  if (!ac) return;
  const t0 = ac.currentTime;
  const frames = Math.floor(ac.sampleRate * duration);
  const buffer = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  }
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = lowpassHz;
  const gain = ac.createGain();
  gain.gain.setValueAtTime(MASTER_GAIN * gainScale, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  src.connect(filter).connect(gain).connect(ac.destination);
  src.start(t0);
}

export function hit(heavy: boolean): void {
  noiseBurst(heavy ? 0.16 : 0.09, heavy ? 1.4 : 1, heavy ? 900 : 1400);
  tone("square", heavy ? 150 : 220, heavy ? 55 : 90, heavy ? 0.14 : 0.08, 0.9);
}

export function block(): void {
  noiseBurst(0.05, 0.6, 2600);
  tone("triangle", 500, 320, 0.06, 0.5);
}

export function whiff(): void {
  noiseBurst(0.05, 0.25, 3200);
}

export function ko(): void {
  tone("sawtooth", 320, 40, 0.6, 1.2);
  noiseBurst(0.4, 1.2, 700);
}

export function roundStart(): void {
  tone("square", 392, 392, 0.12, 0.8);
  tone("square", 523, 523, 0.18, 0.8, 0.14);
}

export function fightCall(): void {
  tone("square", 659, 659, 0.1, 0.9);
  tone("square", 880, 880, 0.22, 0.9, 0.1);
}

export function win(): void {
  tone("square", 523, 523, 0.12, 0.8);
  tone("square", 659, 659, 0.12, 0.8, 0.12);
  tone("square", 784, 784, 0.3, 0.8, 0.24);
}

export function lose(): void {
  tone("square", 330, 330, 0.16, 0.8);
  tone("square", 262, 262, 0.16, 0.8, 0.16);
  tone("square", 196, 196, 0.4, 0.8, 0.32);
}

export function coin(): void {
  // classic two-ping coin drop
  tone("square", 988, 988, 0.08, 0.9);
  tone("square", 1319, 1319, 0.35, 0.9, 0.08);
}

/** Retro arcade "voice" — a formant-ish sawtooth bark, pitched per fighter. */
export function shout(kind: "light" | "heavy" | "super" | "win", opponentVoice = false): void {
  const ac = ctx();
  if (!ac) return;
  const pitch = opponentVoice ? 0.82 : 1; // opponent sounds a touch deeper
  if (kind === "light") {
    tone("sawtooth", 340 * pitch, 180 * pitch, 0.09, 0.5);
  } else if (kind === "heavy") {
    tone("sawtooth", 300 * pitch, 120 * pitch, 0.16, 0.7);
    noiseBurst(0.06, 0.3, 900);
  } else if (kind === "super") {
    tone("sawtooth", 260 * pitch, 420 * pitch, 0.12, 0.8);
    tone("sawtooth", 420 * pitch, 110 * pitch, 0.28, 0.8, 0.1);
    noiseBurst(0.12, 0.4, 800);
  } else {
    // win: a cocky two-note rise
    tone("sawtooth", 240 * pitch, 300 * pitch, 0.14, 0.6);
    tone("sawtooth", 300 * pitch, 380 * pitch, 0.22, 0.6, 0.16);
  }
}

/** Heavy body hitting the pavement. */
export function thud(): void {
  noiseBurst(0.18, 1.1, 500);
  tone("sine", 110, 45, 0.16, 1);
}
