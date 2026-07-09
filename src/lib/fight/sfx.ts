// ============================================================================
// Tiny procedural retro SFX synth (Web Audio API) — no audio assets needed.
// The AudioContext can only start after a user gesture, so unlock() is called
// from the keydown handler in FightCanvas.
//
// Design notes (KOF-style "the punch hurts" mixing):
// - every attack type has its own layered sound: light = high snap, heavy
//   punch = mid burst, heavy kick = low boom, super = punch+blast+sub+metal
// - a 60Hz sub-bass layer rides under supers, KOs and hard landings so the
//   impact is felt, not just heard
// - everything routes through a shared compressor so the loud layers can be
//   genuinely loud without clipping
// - hits carry a stereo pan matching where they land on screen, and a small
//   random pitch drift so mashing never sounds machine-gun identical
// ============================================================================

let audioCtx: AudioContext | null = null;
let unlocked = false;
let masterNode: GainNode | null = null;

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

const MASTER_GAIN = 0.19;

/** Shared master bus: gain → compressor → speakers. */
function master(ac: AudioContext): AudioNode {
  if (!masterNode) {
    masterNode = ac.createGain();
    masterNode.gain.value = 1;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 8;
    comp.ratio.value = 5;
    comp.attack.value = 0.002;
    comp.release.value = 0.12;
    masterNode.connect(comp).connect(ac.destination);
  }
  return masterNode;
}

/** Small human drift so repeated hits never sound identical. */
function vary(v: number, pct = 0.05): number {
  return v * (1 + (Math.random() * 2 - 1) * pct);
}

function outChain(ac: AudioContext, pan: number): AudioNode {
  const dest = master(ac);
  if (pan !== 0 && typeof ac.createStereoPanner === "function") {
    const p = ac.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, pan));
    p.connect(dest);
    return p;
  }
  return dest;
}

function tone(
  type: OscillatorType,
  startFreq: number,
  endFreq: number,
  duration: number,
  gainScale = 1,
  delay = 0,
  pan = 0
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
  osc.connect(gain).connect(outChain(ac, pan));
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

function noiseBurst(duration: number, gainScale = 1, lowpassHz = 1200, delay = 0, pan = 0, highpassHz = 0): void {
  const ac = ctx();
  if (!ac) return;
  const t0 = ac.currentTime + delay;
  const frames = Math.floor(ac.sampleRate * duration);
  const buffer = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  }
  const src = ac.createBufferSource();
  src.buffer = buffer;
  let node: AudioNode = src;
  const lp = ac.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.value = lowpassHz;
  node.connect(lp);
  node = lp;
  if (highpassHz > 0) {
    const hp = ac.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = highpassHz;
    node.connect(hp);
    node = hp;
  }
  const gain = ac.createGain();
  gain.gain.setValueAtTime(MASTER_GAIN * gainScale, t0);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  node.connect(gain).connect(outChain(ac, pan));
  src.start(t0);
}

/** 60Hz chest-thump. Short, felt more than heard. */
function subBoom(gainScale = 2.2, duration = 0.09, delay = 0): void {
  tone("sine", 62, 48, duration, gainScale, delay);
}

// ---------------------------------------------------------------------------
// Attack impacts — one voice per attack type
// ---------------------------------------------------------------------------

export type HitKind = "lp" | "lk" | "hp" | "hk" | "super";

export function hit(kind: HitKind, pan = 0): void {
  switch (kind) {
    case "lp": // 啪 — high, snappy slap
      noiseBurst(0.05, 1.5, 2800, 0, pan, 1100);
      tone("square", vary(330), 180, 0.06, 1.0, 0, pan);
      break;
    case "lk": // slightly meatier snap
      noiseBurst(0.06, 1.5, 2200, 0, pan, 700);
      tone("square", vary(270), 140, 0.07, 1.1, 0, pan);
      break;
    case "hp": // 砰 — mid-low burst
      noiseBurst(0.12, 2.1, 950, 0, pan);
      tone("square", vary(165), 55, 0.12, 1.5, 0, pan);
      tone("sine", 95, 50, 0.1, 1.3, 0, pan);
      break;
    case "hk": // 咚 — the low one
      noiseBurst(0.14, 2.0, 650, 0, pan);
      tone("sine", vary(112), 38, 0.16, 1.9, 0, pan);
      subBoom(1.4, 0.07);
      break;
    case "super": // 轰 — punch + blast + sub + metal, stacked
      noiseBurst(0.16, 2.4, 900, 0, pan); // punch body
      tone("sawtooth", 300, 45, 0.3, 1.6, 0, pan); // blast sweep
      subBoom(2.6, 0.11); // chest hit
      tone("square", 820, 780, 0.22, 0.45, 0.01, pan); // metallic ring,
      tone("square", 1244, 1180, 0.16, 0.3, 0.01, pan); // slightly detuned pair
      noiseBurst(0.25, 0.7, 8000, 0.02, pan, 3000); // debris shimmer
      break;
  }
}

export function block(pan = 0): void {
  noiseBurst(0.05, 0.7, 2600, 0, pan);
  tone("triangle", 500, 320, 0.06, 0.55, 0, pan);
}

export function whiff(): void {
  noiseBurst(0.05, 0.3, 3200);
}

/** The finishing blow. Bigger than a super, followed by a beat of silence
 *  (the BGM/ambience duck is triggered by the caller). */
export function koBlast(pan = 0): void {
  noiseBurst(0.2, 2.8, 750, 0, pan);
  tone("sawtooth", 340, 38, 0.5, 1.9, 0, pan);
  subBoom(3.0, 0.13);
  subBoom(2.0, 0.1, 0.09); // double sub pulse — the body gives out
  tone("square", 760, 700, 0.25, 0.5, 0.01, pan);
  noiseBurst(0.5, 1.0, 480, 0.05, pan);
}

/** Kept for compatibility; prefer koBlast(). */
export function ko(): void {
  koBlast(0);
}

// ---------------------------------------------------------------------------
// Physics impacts
// ---------------------------------------------------------------------------

/** Metallic corner clang — wall bounces ring, they don't thud. */
export function wallClang(pan = 0): void {
  tone("square", vary(740), 690, 0.18, 0.8, 0, pan);
  tone("triangle", vary(1180), 1120, 0.12, 0.55, 0, pan);
  tone("square", 355, 340, 0.14, 0.5, 0.005, pan);
  noiseBurst(0.05, 0.8, 8000, 0, pan, 2400);
}

/** Body hits the pavement. intensity 0..1 scales volume, weight and sub. */
export function thud(intensity = 0.6, pan = 0): void {
  const i = Math.max(0, Math.min(1, intensity));
  noiseBurst(0.12 + 0.1 * i, 1.0 + 1.6 * i, 380 + 260 * i, 0, pan);
  tone("sine", vary(105), 42, 0.12 + 0.08 * i, 1.0 + 1.6 * i, 0, pan);
  if (i > 0.55) subBoom(1.2 + 1.4 * i, 0.09);
}

// ---------------------------------------------------------------------------
// Crowd
// ---------------------------------------------------------------------------

/** Synthesized crowd swell. level 1 = 오~, 2 = 우와!!, 3 = KO eruption. */
export function crowdCheer(level: 1 | 2 | 3, delay = 0): void {
  const ac = ctx();
  if (!ac) return;
  const dur = level === 1 ? 0.5 : level === 2 ? 0.8 : 1.3;
  const gainScale = level === 1 ? 1.4 : level === 2 ? 2.2 : 3.2;
  const t0 = ac.currentTime + delay;

  // breathy roar bed: noise through a voice-band filter, swelling in
  const frames = Math.floor(ac.sampleRate * dur);
  const buffer = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = Math.random() * 2 - 1;
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const band = ac.createBiquadFilter();
  band.type = "bandpass";
  band.frequency.value = 420;
  band.Q.value = 0.8;
  const gain = ac.createGain();
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.linearRampToValueAtTime(MASTER_GAIN * gainScale, t0 + dur * 0.25);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(band).connect(gain).connect(master(ac));
  src.start(t0);

  // a few "voices" poking out of the roar
  const voices = level === 1 ? 2 : level === 2 ? 4 : 6;
  for (let v = 0; v < voices; v++) {
    const f = vary(300 + v * 70, 0.12);
    tone("sawtooth", f, f * 1.25, 0.18, 0.28, delay + 0.05 + v * 0.05, (v % 2 === 0 ? -1 : 1) * 0.3);
  }
}

// ---------------------------------------------------------------------------
// Jingles & voice
// ---------------------------------------------------------------------------

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
