// ============================================================================
// Arcade-room ambience, synthesized live with Web Audio — a 1997 game center:
// CRT hum, muffled crowd murmur, and the occasional button clack / coin drop
// from neighboring cabinets. Same lazily-unlocked AudioContext policy as
// sfx.ts; everything sits far below the BGM in the mix.
// ============================================================================

let audioCtx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let blipTimer: ReturnType<typeof setInterval> | null = null;
let blipTick = 0;

const MASTER_VOLUME = 0.035;

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

function noiseLoop(ac: AudioContext, master: GainNode, lowpassHz: number, gainScale: number) {
  const seconds = 2;
  const frames = ac.sampleRate * seconds;
  const buffer = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buffer.getChannelData(0);
  // brown noise: integrate white noise for a soft room rumble
  let last = 0;
  for (let i = 0; i < frames; i++) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.5;
  }
  const src = ac.createBufferSource();
  src.buffer = buffer;
  src.loop = true;
  const filter = ac.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = lowpassHz;
  const gain = ac.createGain();
  gain.gain.value = gainScale;
  src.connect(filter).connect(gain).connect(master);
  src.start();
}

function blip(ac: AudioContext, master: GainNode, freq: number, dur: number, gainScale: number) {
  const t0 = ac.currentTime;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = "square";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(gainScale, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
  osc.connect(gain).connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export function startAmbience(): void {
  const ac = ensureContext();
  if (!ac || masterGain) return;
  masterGain = ac.createGain();
  masterGain.gain.value = MASTER_VOLUME;
  masterGain.connect(ac.destination);

  // muffled crowd murmur + room rumble
  noiseLoop(ac, masterGain, 420, 0.5);
  // CRT / fluorescent hum (60Hz mains + a faint harmonic)
  const hum = ac.createOscillator();
  hum.type = "sine";
  hum.frequency.value = 60;
  const humGain = ac.createGain();
  humGain.gain.value = 0.12;
  hum.connect(humGain).connect(masterGain);
  hum.start();
  const hum2 = ac.createOscillator();
  hum2.type = "sine";
  hum2.frequency.value = 120;
  const hum2Gain = ac.createGain();
  hum2Gain.gain.value = 0.05;
  hum2.connect(hum2Gain).connect(masterGain);
  hum2.start();

  // neighboring cabinets: irregular button clacks, the odd coin drop
  blipTimer = setInterval(() => {
    if (!audioCtx || !masterGain) return;
    blipTick += 1;
    if (blipTick % 3 === 0) blip(audioCtx, masterGain, 520 + (blipTick % 5) * 130, 0.03, 0.25);
    if (blipTick % 11 === 0) {
      blip(audioCtx, masterGain, 988, 0.06, 0.3);
      blip(audioCtx, masterGain, 1319, 0.2, 0.25);
    }
  }, 700);
}

export function stopAmbience(): void {
  if (blipTimer !== null) {
    clearInterval(blipTimer);
    blipTimer = null;
  }
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
