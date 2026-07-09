"use client";

import { useEffect, useRef, useState } from "react";
import { Opponent } from "@/types/game";
import { createWorld, stepFight } from "@/lib/fight/engine";
import { createAiBrain, tickAi } from "@/lib/fight/ai";
import { ANIMS, AnimName, FRAME_SIZE, LoadedSheets, loadSheets } from "@/lib/fight/spriteSheets";
import { Fighter, FightInput, NEUTRAL_INPUT } from "@/lib/fight/types";
import { ATTACKS } from "@/lib/fight/constants";
import { MAX_HP, ROUNDS_TO_WIN, ROUND_TIME_SECONDS, STAGE_WIDTH } from "@/lib/fight/constants";
import * as sfx from "@/lib/fight/sfx";
import { duckBgm, startBgm, stopBgm } from "@/lib/fight/bgm";
import { duckAmbience, startAmbience, stopAmbience } from "@/lib/fight/ambience";

export interface FightMatchResult {
  won: boolean;
  comeback: boolean;
  landedAntiAir: boolean;
  landedCombo: boolean;
}

const CANVAS_W = 768;
const CANVAS_H = 432;
const GROUND_SCREEN_Y = 360;
const SCALE = CANVAS_W / STAGE_WIDTH;
const FIGURE_HEIGHT = 170; // on-screen fighter height in canvas px

const KEY_MAP: Record<string, keyof FightInput> = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  KeyZ: "lp",
  KeyX: "hp",
  KeyC: "lk",
  KeyV: "hk",
  Space: "super",
};

type RoundPhase = "intro" | "fight" | "roundEnd" | "matchEnd";

interface AnimTracker {
  key: string;
  startedAt: number;
}

export default function FightCanvas({
  opponent,
  onEnd,
  winStreak = 0,
}: {
  opponent: Opponent;
  onEnd: (result: FightMatchResult) => void;
  winStreak?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const onEndRef = useRef(onEnd);
  onEndRef.current = onEnd;
  const [assetsReady, setAssetsReady] = useState(false);
  const [isTouch, setIsTouch] = useState(false);
  const touchInputRef = useRef<FightInput>({ ...NEUTRAL_INPUT });

  useEffect(() => {
    setIsTouch(navigator.maxTouchPoints > 0 || "ontouchstart" in window);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return;
    // `ctx` is swapped to the offscreen buffer while the background renders,
    // then restored — lets the whole background get stamped back blurred
    // (depth of field) and darkened in one pass.
    let ctx: CanvasRenderingContext2D = ctx2d;
    const bgCanvas = document.createElement("canvas");
    bgCanvas.width = CANVAS_W;
    bgCanvas.height = CANVAS_H;
    const bgCtx2d = bgCanvas.getContext("2d");
    if (!bgCtx2d) return;
    const bgCtx: CanvasRenderingContext2D = bgCtx2d;

    let cancelled = false;
    let rafId = 0;
    let sheets: LoadedSheets | null = null;

    const keys = new Set<string>();
    const onKeyDown = (e: KeyboardEvent) => {
      if (KEY_MAP[e.code]) e.preventDefault();
      sfx.unlock();
      startBgm(); // no-op if already playing; needs a user gesture to start
      startAmbience();
      keys.add(e.code);
    };
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    function inputFromKeys(): FightInput {
      const input: FightInput = { ...NEUTRAL_INPUT };
      keys.forEach((code) => {
        const field = KEY_MAP[code];
        if (field) input[field] = true;
      });
      // merge on-screen touch controls
      const touch = touchInputRef.current;
      (Object.keys(touch) as Array<keyof FightInput>).forEach((k) => {
        if (touch[k]) input[k] = true;
      });
      return input;
    }

    let world = createWorld();
    const aiBrain = createAiBrain();
    let phase: RoundPhase = "intro";
    let phaseTimer = 90;
    let playerRounds = 0;
    let opponentRounds = 0;
    let roundNumber = 1;
    let timeLeftFrames = ROUND_TIME_SECONDS * 60;
    let landedAntiAir = false;
    let landedCombo = false;
    let playerWasDown = false;
    let ended = false;
    let animTimer = 0;

    // --- game-feel state -----------------------------------------------------
    let hitstopFrames = 0; // world freeze on impact
    let shakeFrames = 0;
    let shakeMag = 0;
    let comboShown = 0;
    let comboTimer = 0;
    let fightCalled = false;
    let resultSounded = false;
    let matchEndTimer = 110; // let the WIN/LOSE banner breathe before leaving

    // Dynamic camera: zooms in as the fighters close distance, with an extra
    // punch-in on KO. HUD is drawn outside the camera transform.
    let camX = CANVAS_W / 2;
    let camZ = 1.02;
    let koZoomFrames = 0;

    // Full-screen white flash on heavy impacts, KOF-style.
    let screenFlash = 0;
    const SCREEN_FLASH_MAX = 12;

    // HP bars keep a slowly-draining "ghost" so big damage reads as a chunk.
    // The ghost holds still for a beat before sliding down (Street Fighter 6 style).
    const ghostHp = { player: MAX_HP, opponent: MAX_HP };
    const ghostDelay = { player: 0, opponent: 0 };

    // Slow motion: the world steps at 1/slowmoDiv speed while active. Supers
    // run at 1/3; the KO fall runs at 1/5 (≈0.2x) for the cinematic.
    let slowmoFrames = 0;
    let slowmoDiv = 3;
    // KO is savored: the loser falls in slow motion before the banner drops,
    // with the camera rushing in on them.
    let koPendingFrames = -1;
    let koFocusId: "player" | "opponent" | null = null;

    // Super freeze frame: the darkest moment of the cinematic, during hitstop.
    let superFreeze = 0;

    // Ground shockwaves from bodies slamming down.
    interface Shockwave {
      x: number;
      life: number;
      maxLife: number;
      big: boolean;
    }
    let shockwaves: Shockwave[] = [];

    // Fighter voice callouts ("하압!", "먹어라!!") floating above the attacker.
    interface Callout {
      text: string;
      x: number;
      y: number;
      life: number;
      maxLife: number;
      color: string;
    }
    let callouts: Callout[] = [];
    const GRUNTS = ["하!", "흐압!", "타아!", "얍!"];
    const SUPER_LINES = ["먹어라!!", "끝이다!!", "이걸로 끝!"];
    const WIN_LINES = ["실력이 부족하군.", "아직 멀었어.", "좋은 승부였다."];
    let gruntIdx = 0;

    function fighterShout(f: Fighter, text: string, color: string) {
      callouts.push({
        text,
        x: f.x * SCALE,
        y: GROUND_SCREEN_Y - f.y * SCALE - FIGURE_HEIGHT - 14,
        life: 0,
        maxLife: 40,
        color,
      });
      if (callouts.length > 3) callouts = callouts.slice(-3);
    }

    // Crowd excitement — they bounce harder and shout when something big lands.
    let crowdHype = 0;
    interface SpeechBubble {
      text: string;
      x: number;
      life: number;
      maxLife: number;
    }
    let bubbles: SpeechBubble[] = [];
    const CROWD_LINES = ["우와 대박!", "한 판 더!", "쟤 좀 치는데?", "오늘 물 올랐네", "동전 아깝지 않다"];
    const CROWD_LINES_BIG = ["필살기다!!", "미쳤다 진짜!", "저걸 맞네;;", "역대급이다"];
    let crowdLineIdx = 0;

    function crowdShoutText(text: string) {
      crowdLineIdx += 1;
      bubbles.push({
        text,
        x: 60 + ((crowdLineIdx * 173) % (CANVAS_W - 160)),
        life: 0,
        maxLife: 80,
      });
      if (bubbles.length > 3) bubbles = bubbles.slice(-3);
    }

    function crowdShout(big: boolean) {
      const pool = big ? CROWD_LINES_BIG : CROWD_LINES;
      crowdShoutText(pool[(crowdLineIdx * 7 + (big ? 3 : 0)) % pool.length]);
    }

    interface Particle {
      x: number;
      y: number;
      vx: number;
      vy: number;
      life: number;
      maxLife: number;
      color: string;
      size: number;
    }
    let particles: Particle[] = [];

    function spawnSparks(x: number, y: number, colors: string[], count: number, speed: number) {
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const v = speed * (0.4 + Math.random() * 0.8);
        particles.push({
          x,
          y,
          vx: Math.cos(angle) * v,
          vy: Math.sin(angle) * v - 1.2,
          life: 0,
          maxLife: 10 + Math.random() * 10,
          color: colors[i % colors.length],
          size: 2 + Math.random() * 3,
        });
      }
    }

    function updateParticles() {
      particles = particles.filter((p) => {
        p.life += 1;
        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.25;
        p.vx *= 0.92;
        return p.life < p.maxLife;
      });
    }

    function impactPoint(defender: Fighter): { x: number; y: number } {
      return {
        x: defender.x * SCALE,
        y: GROUND_SCREEN_Y - defender.y * SCALE - FIGURE_HEIGHT * 0.55,
      };
    }

    /** Stereo position for a sound landing at screen x. */
    function panFor(x: number): number {
      return Math.max(-0.45, Math.min(0.45, (x / CANVAS_W - 0.5) * 0.9));
    }

    // KOF-style contact flash: a rotating four-point star with a hot core,
    // plus radial speed lines on heavy impacts.
    interface ImpactFlash {
      x: number;
      y: number;
      life: number;
      maxLife: number;
      size: number;
      color: string;
      lines: boolean;
    }
    let flashes: ImpactFlash[] = [];

    function spawnImpactFlash(x: number, y: number, size: number, color: string, lines: boolean) {
      flashes.push({ x, y, life: 0, maxLife: 9, size, color, lines });
    }

    function updateFlashes() {
      flashes = flashes.filter((fl) => {
        fl.life += 1;
        return fl.life < fl.maxLife;
      });
    }

    function drawFlashes() {
      if (!flashes.length) return;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (const fl of flashes) {
        const t = fl.life / fl.maxLife;
        const r = fl.size * (0.5 + t * 0.9);
        ctx.globalAlpha = 1 - t;
        const core = ctx.createRadialGradient(fl.x, fl.y, 0, fl.x, fl.y, r * 0.55);
        core.addColorStop(0, "#ffffff");
        core.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = core;
        ctx.beginPath();
        ctx.arc(fl.x, fl.y, r * 0.55, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = fl.color;
        ctx.save();
        ctx.translate(fl.x, fl.y);
        ctx.rotate(0.4 + t * 0.7);
        for (const rot of [0, Math.PI / 2]) {
          ctx.save();
          ctx.rotate(rot);
          ctx.beginPath();
          ctx.moveTo(-r, 0);
          ctx.lineTo(0, -r * 0.18);
          ctx.lineTo(r, 0);
          ctx.lineTo(0, r * 0.18);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
        ctx.restore();
        if (fl.lines) {
          ctx.strokeStyle = fl.color;
          ctx.lineWidth = 2;
          for (let i = 0; i < 8; i++) {
            const a = (Math.PI * 2 * i) / 8 + 0.3;
            ctx.beginPath();
            ctx.moveTo(fl.x + Math.cos(a) * r * 0.8, fl.y + Math.sin(a) * r * 0.8);
            ctx.lineTo(fl.x + Math.cos(a) * r * 1.6, fl.y + Math.sin(a) * r * 1.6);
            ctx.stroke();
          }
        }
      }
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    // Afterimage trail while a super is live — fading snapshots of recent poses.
    interface TrailGhost {
      x: number;
      y: number;
      facing: number;
      anim: AnimName;
      frame: number;
      life: number;
    }
    let trails: TrailGhost[] = [];
    const lastPose: Record<string, Omit<TrailGhost, "life"> | null> = { player: null, opponent: null };

    function updateTrails() {
      trails = trails.filter((tr) => {
        tr.life += 1;
        return tr.life < 12;
      });
    }

    const trackers: Record<string, AnimTracker> = {
      player: { key: "", startedAt: 0 },
      opponent: { key: "", startedAt: 0 },
    };

    /** Maps engine fighter state to (animation, frame index, vertical squash). */
    function resolveAnim(f: Fighter): { anim: AnimName; frame: number; squashY: number } {
      let anim: AnimName;
      let progress: number | null = null; // 0..1 progress override for attacks

      if (f.action === "ko") {
        anim = "death";
      } else if (f.action === "attack" && f.attackId) {
        anim = f.attackId === "lp" || f.attackId === "lk" ? "attack1" : "attack2";
        // super reuses attack2 frames but is drawn with an aura (see drawFighter)
        const def = ATTACKS[f.attackId];
        progress = Math.min(1, f.actionFrame / (def.startup + def.active + def.recovery));
      } else if (f.action === "hitstun" || f.action === "block") {
        anim = "takeHit";
      } else if (f.action === "jump" || f.y > 0) {
        anim = f.vy > 0.5 ? "jump" : "fall";
      } else if (f.action === "walk") {
        anim = "run";
      } else {
        anim = "idle";
      }

      const def = ANIMS[anim];
      const tracker = trackers[f.id];
      const key = f.action === "attack" ? `${anim}:${f.attackId}:${f.action}` : anim;
      if (tracker.key !== key) {
        tracker.key = key;
        tracker.startedAt = animTimer;
      }

      let frame: number;
      if (progress !== null) {
        frame = Math.min(def.frames - 1, Math.floor(progress * def.frames));
      } else {
        const elapsed = Math.floor((animTimer - tracker.startedAt) / def.ticksPerFrame);
        frame = def.loop ? elapsed % def.frames : Math.min(def.frames - 1, elapsed);
      }

      return { anim, frame, squashY: f.action === "crouch" ? 0.72 : 1 };
    }

    function filterFor(f: Fighter, isOpponent: boolean): string {
      const parts: string[] = [];
      if (isOpponent) parts.push("hue-rotate(150deg)", "saturate(1.25)");
      if (f.action === "hitstun" && animTimer % 4 < 2) parts.push("brightness(1.9)");
      if (f.action === "block") parts.push("brightness(1.25)", "saturate(1.5)");
      return parts.length ? parts.join(" ") : "none";
    }

    function drawSprite(
      anim: AnimName,
      frame: number,
      feetX: number,
      feetY: number,
      facing: number,
      squashY: number,
      alpha: number,
      filter: string
    ) {
      if (!sheets) return;
      const img = sheets.images[anim];
      const { centerX, bottomY, height } = sheets.anchor;
      const s = FIGURE_HEIGHT / height;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(feetX, feetY);
      ctx.scale(facing, squashY);
      ctx.imageSmoothingEnabled = false;
      ctx.filter = filter;
      ctx.drawImage(
        img,
        frame * FRAME_SIZE,
        0,
        FRAME_SIZE,
        FRAME_SIZE,
        -centerX * s,
        -bottomY * s,
        FRAME_SIZE * s,
        FRAME_SIZE * s
      );
      ctx.restore();
    }

    function drawTrails() {
      for (const tr of trails) {
        const fade = (1 - tr.life / 12) * 0.45;
        drawSprite(tr.anim, tr.frame, tr.x, tr.y, tr.facing, 1, fade, "brightness(1.6) saturate(0.4)");
      }
    }

    function drawFighter(f: Fighter, isOpponent: boolean) {
      if (!sheets) return;
      const { anim, frame, squashY } = resolveAnim(f);

      const feetX = f.x * SCALE;
      const feetY = GROUND_SCREEN_Y - f.y * SCALE;
      lastPose[f.id] = { x: feetX, y: feetY, facing: f.facing, anim, frame };

      // super aura behind the fighter while the super attack is live
      if (f.action === "attack" && f.attackId === "super") {
        const pulse = 0.75 + Math.sin(animTimer * 0.9) * 0.25;
        const aura = ctx.createRadialGradient(feetX, feetY - FIGURE_HEIGHT * 0.5, 10, feetX, feetY - FIGURE_HEIGHT * 0.5, 110);
        aura.addColorStop(0, `rgba(255,220,90,${0.5 * pulse})`);
        aura.addColorStop(1, "rgba(255,220,90,0)");
        ctx.fillStyle = aura;
        ctx.fillRect(feetX - 120, feetY - FIGURE_HEIGHT - 40, 240, FIGURE_HEIGHT + 60);
      }

      let filter = filterFor(f, isOpponent);
      if (f.action === "attack" && f.attackId === "super") {
        filter = filter === "none" ? "brightness(1.4) saturate(1.5)" : `${filter} brightness(1.4) saturate(1.5)`;
      }
      drawSprite(anim, frame, feetX, feetY, f.facing, squashY, 1, filter);
    }

    function drawHpBar(x: number, hp: number, ghost: number, alignRight: boolean) {
      const w = 280;
      const h = 18;
      const pct = Math.max(0, Math.min(1, hp / MAX_HP));
      const ghostPct = Math.max(pct, Math.min(1, ghost / MAX_HP));
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.fillRect(x, 14, w, h);
      // recently-lost chunk drains slowly so big damage reads at a glance
      if (ghostPct > pct) {
        ctx.fillStyle = animTimer % 8 < 4 ? "#ffe9d6" : "#ff8a5c";
        if (alignRight) ctx.fillRect(x + w * (1 - ghostPct), 14, w * (ghostPct - pct), h);
        else ctx.fillRect(x + w * pct, 14, w * (ghostPct - pct), h);
      }
      const low = pct <= 0.35;
      const grad = ctx.createLinearGradient(0, 14, 0, 14 + h);
      if (low) {
        const blink = animTimer % 30 < 15;
        grad.addColorStop(0, blink ? "#ff8a5c" : "#ff5c3b");
        grad.addColorStop(1, blink ? "#d8452a" : "#a82f1e");
      } else {
        grad.addColorStop(0, "#8aff9e");
        grad.addColorStop(1, "#1fae4a");
      }
      ctx.fillStyle = grad;
      if (alignRight) ctx.fillRect(x + w * (1 - pct), 14, w * pct, h);
      else ctx.fillRect(x, 14, w * pct, h);
      // segment ticks every 10%
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 1;
      for (let i = 1; i < 10; i++) {
        ctx.beginPath();
        ctx.moveTo(x + (w / 10) * i, 14);
        ctx.lineTo(x + (w / 10) * i, 14 + h);
        ctx.stroke();
      }
      ctx.strokeStyle = "#fff";
      ctx.strokeRect(x, 14, w, h);
    }

    function drawMeterBar(x: number, meter: number, alignRight: boolean) {
      const w = 180;
      const h = 7;
      const y = 38;
      const pct = Math.max(0, Math.min(1, meter / 100));
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(x, y, w, h);
      const full = pct >= 1;
      ctx.fillStyle = full ? (animTimer % 12 < 6 ? "#ffe14d" : "#fff7cf") : "#3f8fd8";
      if (alignRight) ctx.fillRect(x + w * (1 - pct), y, w * pct, h);
      else ctx.fillRect(x, y, w * pct, h);
      ctx.strokeStyle = "rgba(255,255,255,0.6)";
      ctx.lineWidth = 1;
      ctx.strokeRect(x, y, w, h);
      if (full) {
        ctx.font = "bold 9px monospace";
        ctx.fillStyle = "#ffe14d";
        ctx.textAlign = alignRight ? "right" : "left";
        ctx.fillText("MAX! (SPACE)", alignRight ? x + w : x, y + 17);
        ctx.textAlign = "left";
      }
    }

    function drawRoundPips(x: number, wins: number, alignRight: boolean) {
      for (let i = 0; i < ROUNDS_TO_WIN; i++) {
        const px = alignRight ? x - i * 16 : x + i * 16;
        ctx.beginPath();
        ctx.arc(px, 56, 5, 0, Math.PI * 2);
        ctx.fillStyle = i < wins ? "#ffe14d" : "rgba(0,0,0,0.55)";
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.7)";
        ctx.stroke();
      }
    }

    function drawHud() {
      drawHpBar(16, world.player.hp, ghostHp.player, false);
      drawHpBar(CANVAS_W - 16 - 280, world.opponent.hp, ghostHp.opponent, true);
      drawMeterBar(16, world.player.meter, false);
      drawMeterBar(CANVAS_W - 16 - 180, world.opponent.meter, true);
      drawRoundPips(24, playerRounds, false);
      drawRoundPips(CANVAS_W - 24, opponentRounds, true);

      // timer plate
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(CANVAS_W / 2 - 26, 10, 52, 30);
      ctx.strokeStyle = "rgba(255,255,255,0.5)";
      ctx.strokeRect(CANVAS_W / 2 - 26, 10, 52, 30);
      ctx.textAlign = "center";
      ctx.fillStyle = timeLeftFrames < 10 * 60 ? "#ff5c5c" : "#fff";
      ctx.font = "bold 20px monospace";
      ctx.fillText(String(Math.max(0, Math.ceil(timeLeftFrames / 60))), CANVAS_W / 2, 32);
      ctx.font = "11px monospace";
      ctx.fillStyle = "#ffe9c9";
      ctx.fillText("YOU", 16 + 140, 60);
      ctx.fillText(opponent.name, CANVAS_W - 16 - 140, 60);

      // combo counter — re-pops big on every added hit, then settles
      if (comboTimer > 0 && comboShown >= 2) {
        const pop = 1 + Math.max(0, comboTimer - 45) * 0.05;
        ctx.font = `bold ${Math.round(26 * pop)}px monospace`;
        ctx.fillStyle = "#ffb43a";
        ctx.strokeStyle = "#3a1500";
        ctx.lineWidth = 4;
        ctx.strokeText(`${comboShown} HITS!`, 96, 140);
        ctx.fillText(`${comboShown} HITS!`, 96, 140);
      }

      if (phase === "intro") {
        if (phaseTimer > 30) {
          ctx.font = "bold 34px monospace";
          ctx.fillStyle = "#ffe14d";
          ctx.strokeStyle = "#40200a";
          ctx.lineWidth = 5;
          ctx.strokeText(`ROUND ${roundNumber}`, CANVAS_W / 2, CANVAS_H / 2 - 40);
          ctx.fillText(`ROUND ${roundNumber}`, CANVAS_W / 2, CANVAS_H / 2 - 40);
          ctx.font = "bold 16px monospace";
          ctx.fillStyle = "#fff";
          ctx.fillText(`나  VS  ${opponent.name}`, CANVAS_W / 2, CANVAS_H / 2);
        } else {
          const scale = 1 + (30 - phaseTimer) * 0.02;
          ctx.font = `bold ${Math.round(40 * scale)}px monospace`;
          ctx.fillStyle = "#ff6a3a";
          ctx.strokeStyle = "#40100a";
          ctx.lineWidth = 6;
          ctx.strokeText("FIGHT!", CANVAS_W / 2, CANVAS_H / 2 - 20);
          ctx.fillText("FIGHT!", CANVAS_W / 2, CANVAS_H / 2 - 20);
        }
      } else if (phase === "roundEnd" || phase === "matchEnd") {
        // banner slams in oversized then settles
        const timer = phase === "matchEnd" ? matchEndTimer : phaseTimer;
        const punch = timer > 92 ? 1 + (timer - 92) * 0.14 : 1;
        ctx.font = `bold ${Math.round(32 * punch)}px monospace`;
        ctx.fillStyle = "#ffe14d";
        ctx.strokeStyle = "#40200a";
        ctx.lineWidth = 5;
        let text: string;
        if (phase === "matchEnd") {
          text = playerRounds > opponentRounds ? "YOU WIN!" : "YOU LOSE...";
        } else if (world.player.action === "ko" || world.opponent.action === "ko") {
          text = "K.O.";
        } else {
          text = "TIME UP";
        }
        ctx.strokeText(text, CANVAS_W / 2, CANVAS_H / 2 - 20);
        ctx.fillText(text, CANVAS_W / 2, CANVAS_H / 2 - 20);
      }
      ctx.textAlign = "left";
    }

    // 1997 arcade interior — a row of running cabinets along the back wall,
    // a loose knot of silhouetted onlookers behind a steel rail, and the
    // open floor where the money matches happen.
    // Each cabinet runs its own thing: an attract demo, a dim tired tube, a
    // black screen begging for coins, one that flickers. A working arcade,
    // not a showroom.
    type CabinetMode = "demo" | "dim" | "off" | "flicker";
    type CabinetDemo = "fight" | "shoot" | "race" | "puzzle" | "base";
    // dy nudges each cabinet off the perfect line — nothing in a real arcade
    // sits flush.
    const CABINETS: Array<{
      x: number;
      w: number;
      dy: number;
      screen: string;
      marquee: string;
      name: string;
      demo: CabinetDemo;
      mode: CabinetMode;
    }> = [
      { x: 8, w: 132, dy: 0, screen: "#59d8ff", marquee: "#ff5c8a", name: "격투 97", demo: "fight", mode: "demo" },
      { x: 160, w: 130, dy: 3, screen: "#7dff8e", marquee: "#ffd54d", name: "슈팅", demo: "shoot", mode: "dim" },
      { x: 317, w: 132, dy: -2, screen: "#ff9de2", marquee: "#59d8ff", name: "레이싱", demo: "race", mode: "off" },
      { x: 472, w: 128, dy: 2, screen: "#ffd27d", marquee: "#7dff8e", name: "퍼즐", demo: "puzzle", mode: "flicker" },
      { x: 622, w: 138, dy: -1, screen: "#9fa8ff", marquee: "#ff8a5c", name: "야구", demo: "base", mode: "demo" },
    ];
    // Game posters slapped on the wall, slightly crooked, some dog-eared —
    // the wallpaper of every 1997 arcade.
    const POSTERS: Array<{ x: number; y: number; w: number; h: number; c: string; title: string; tilt: number; torn: boolean }> = [
      { x: 58, y: 92, w: 38, h: 52, c: "#7a2f4a", title: "KOF'97", tilt: -0.05, torn: false },
      { x: 224, y: 86, w: 34, h: 48, c: "#5a5a2f", title: "METAL SLUG", tilt: 0.04, torn: true },
      { x: 556, y: 88, w: 32, h: 46, c: "#2f4a7a", title: "FATAL FURY", tilt: 0.06, torn: false },
      { x: 668, y: 92, w: 36, h: 50, c: "#4a2f6a", title: "사무라이", tilt: -0.04, torn: true },
    ];
    // Onlookers stand in knots, not a parade line. Clustered offsets overlap
    // so each knot reads as one mass of people. Ordered so a small crowd
    // still spreads across all three knots; reaction gives each person a
    // different move on the big moments.
    const CROWD_ORDER: Array<{ x: number; h: number; back: boolean; reaction: number }> = [
      { x: 142, h: 1.02, back: false, reaction: 1 },
      { x: 612, h: 1.0, back: false, reaction: 0 },
      { x: 420, h: 1.05, back: false, reaction: 2 },
      { x: 152, h: 0.96, back: false, reaction: 0 },
      { x: 621, h: 0.88, back: true, reaction: 3 },
      { x: 431, h: 0.9, back: false, reaction: 1 },
      { x: 133, h: 0.9, back: true, reaction: 3 },
      { x: 632, h: 0.98, back: false, reaction: 2 },
      { x: 410, h: 0.95, back: true, reaction: 0 },
      { x: 163, h: 0.85, back: true, reaction: 2 },
      { x: 594, h: 0.86, back: true, reaction: 1 },
      { x: 645, h: 0.9, back: true, reaction: 0 },
    ];

    /** Horizontal offset that makes a layer lag (factor < 1) or lead
     *  (factor > 1) the camera — cheap parallax depth. */
    function layerShift(factor: number): number {
      return (camX - CANVAS_W / 2) * (1 - factor);
    }

    /** Tiny attract-mode loops so the screens look like running games. */
    function drawCabinetScreen(
      c: (typeof CABINETS)[number],
      ci: number,
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      modeOverride?: CabinetMode
    ) {
      const mode = modeOverride ?? c.mode;
      ctx.save();
      ctx.beginPath();
      ctx.rect(sx, sy, sw, sh);
      ctx.clip();

      // per-tube character: dim, flickering, or dead-waiting-for-coins
      let alpha = 0.9;
      if (mode === "dim") alpha = 0.42;
      else if (mode === "flicker") alpha = (animTimer * 7 + ci * 31) % 90 < 5 ? 0.25 : 0.8;

      if (mode === "off") {
        ctx.fillStyle = "#05030a";
        ctx.fillRect(sx, sy, sw, sh);
        if (Math.floor(animTimer / 45) % 2 === 0) {
          ctx.fillStyle = c.screen;
          ctx.font = "bold 9px monospace";
          ctx.textAlign = "center";
          ctx.fillText("INSERT COIN", sx + sw / 2, sy + sh / 2 + 3);
        }
      } else {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = "#0a0714";
        ctx.fillRect(sx, sy, sw, sh);
        const t = animTimer + ci * 120;
        if (c.demo === "fight") {
          // title → two fighters closing in → high score, on a loop
          const phase = Math.floor(t / 300) % 3;
          if (phase === 0) {
            ctx.fillStyle = c.screen;
            ctx.font = "bold 13px monospace";
            ctx.textAlign = "center";
            ctx.fillText("KOF'97", sx + sw / 2, sy + sh / 2 - 4);
            if (Math.floor(t / 30) % 2 === 0) {
              ctx.font = "7px monospace";
              ctx.fillText("PUSH START", sx + sw / 2, sy + sh / 2 + 12);
            }
          } else if (phase === 1) {
            const gy = sy + sh - 12;
            ctx.fillStyle = "#1c1430";
            ctx.fillRect(sx, gy, sw, 12);
            const gap = 14 + Math.abs(Math.sin(t * 0.05)) * (sw - 44);
            ctx.fillStyle = "#ff8a5c";
            ctx.fillRect(sx + sw / 2 - gap / 2 - 5, gy - 16, 10, 16);
            ctx.fillStyle = c.screen;
            ctx.fillRect(sx + sw / 2 + gap / 2 - 5, gy - 16, 10, 16);
            if (gap < 20) {
              ctx.fillStyle = "#ffffff";
              ctx.fillRect(sx + sw / 2 - 3, gy - 14, 6, 6);
            }
            ctx.fillStyle = "#7dff8e";
            ctx.fillRect(sx + 4, sy + 5, sw * 0.35, 3);
            ctx.fillRect(sx + sw - 4 - sw * 0.35, sy + 5, sw * 0.35, 3);
          } else {
            ctx.fillStyle = c.screen;
            ctx.font = "8px monospace";
            ctx.textAlign = "center";
            ctx.fillText("HIGH SCORE", sx + sw / 2, sy + sh / 2 - 6);
            ctx.fillText("00012300", sx + sw / 2, sy + sh / 2 + 8);
          }
        } else if (c.demo === "shoot") {
          ctx.fillStyle = "#cfe8ff";
          for (let i = 0; i < 9; i++) {
            const star = (i * 37 + t * 1.4) % sh;
            ctx.fillRect(sx + ((i * 53) % sw), sy + star, 2, 2);
          }
          const shipX = sx + sw / 2 + Math.sin(t * 0.03) * (sw * 0.3);
          ctx.fillStyle = c.screen;
          ctx.beginPath();
          ctx.moveTo(shipX, sy + sh - 16);
          ctx.lineTo(shipX - 6, sy + sh - 6);
          ctx.lineTo(shipX + 6, sy + sh - 6);
          ctx.closePath();
          ctx.fill();
        } else if (c.demo === "race") {
          ctx.fillStyle = "#101624";
          ctx.fillRect(sx, sy, sw, sh);
          ctx.strokeStyle = "#3a4a66";
          ctx.beginPath();
          ctx.moveTo(sx + 8, sy + sh);
          ctx.lineTo(sx + sw * 0.42, sy);
          ctx.moveTo(sx + sw - 8, sy + sh);
          ctx.lineTo(sx + sw * 0.58, sy);
          ctx.stroke();
          ctx.fillStyle = "#e8e0d0";
          for (let i = 0; i < 4; i++) {
            const dy = (t * 2 + i * 18) % sh;
            const wFrac = dy / sh;
            ctx.fillRect(sx + sw / 2 - 1 - wFrac, sy + dy, 2 + wFrac * 2, 5 + wFrac * 3);
          }
          ctx.fillStyle = c.screen;
          ctx.fillRect(sx + sw / 2 - 7 + Math.sin(t * 0.02) * 8, sy + sh - 14, 14, 9);
        } else if (c.demo === "puzzle") {
          const cols = 5;
          const rows = 4;
          const bw = (sw - 12) / cols;
          const bh = 8;
          const palette = ["#ff5c8a", "#ffd54d", "#59d8ff", "#7dff8e"];
          for (let r = 0; r < rows; r++) {
            for (let q = 0; q < cols; q++) {
              if ((q * 7 + r * 5) % 9 === 0) continue; // gaps in the stack
              const blinkRow = Math.floor(t / 120) % rows === r && Math.floor(t / 15) % 2 === 0;
              ctx.fillStyle = blinkRow ? "#ffffff" : palette[(q + r) % palette.length];
              ctx.fillRect(sx + 6 + q * bw, sy + sh - 10 - r * (bh + 1), bw - 2, bh);
            }
          }
        } else {
          // baseball: green field, a pitched ball arcing out
          ctx.fillStyle = "#14301c";
          ctx.fillRect(sx, sy, sw, sh);
          ctx.strokeStyle = "#2c5a38";
          ctx.strokeRect(sx + 10, sy + 10, sw - 20, sh - 20);
          const bt = (t % 90) / 90;
          ctx.fillStyle = "#ffffff";
          ctx.beginPath();
          ctx.arc(sx + 12 + bt * (sw - 24), sy + sh - 12 - Math.sin(bt * Math.PI) * (sh - 22), 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.globalAlpha = 1;
      }

      // rolling CRT band drifting down every screen
      ctx.fillStyle = "rgba(255,255,255,0.06)";
      ctx.fillRect(sx, sy + ((animTimer * 0.7 + ci * 40) % sh), sw, 5);
      ctx.restore();
      ctx.globalAlpha = 1;
    }

    function drawBackground() {
      // Room shell: warm dark wall
      const wall = ctx.createLinearGradient(0, 0, 0, GROUND_SCREEN_Y);
      wall.addColorStop(0, "#1c0f22");
      wall.addColorStop(0.5, "#2a1731");
      wall.addColorStop(1, "#3a2140");
      ctx.fillStyle = wall;
      ctx.fillRect(0, 0, CANVAS_W, GROUND_SCREEN_Y);

      // --- far wall (slowest layer): ceiling, posters, neon sign ---
      ctx.save();
      ctx.translate(layerShift(0.2), 0);

      ctx.fillStyle = "#120a18";
      ctx.fillRect(-80, 0, CANVAS_W + 160, 44);
      for (const tx of [96, 356, 606]) {
        const flick = (animTimer + tx) % 240 > 6 ? 1 : 0.35; // tired fluorescent stutter
        // hanging cords
        ctx.fillStyle = "#0a0510";
        ctx.fillRect(tx + 18, 12, 2, 22);
        ctx.fillRect(tx + 100, 12, 2, 22);
        ctx.fillStyle = `rgba(220,235,255,${0.12 * flick})`;
        ctx.fillRect(tx - 18, 30, 156, 26);
        ctx.fillStyle = `rgba(235,245,255,${0.9 * flick})`;
        ctx.fillRect(tx, 34, 120, 6);
      }

      for (const p of POSTERS) {
        ctx.save();
        ctx.translate(p.x + p.w / 2, p.y + p.h / 2);
        ctx.rotate(p.tilt);
        ctx.fillStyle = "#e8ddca"; // aged paper border
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.w / 2 + 2, -p.h / 2 + 2, p.w - 4, p.h - 4);
        // key art: a fighter silhouette mid-punch
        ctx.fillStyle = "rgba(10,6,14,0.85)";
        ctx.beginPath();
        ctx.arc(-1, -3, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(-5, 1, 9, 13);
        ctx.fillRect(4, 2, 8, 3);
        // title band
        ctx.fillStyle = "#e8ddca";
        ctx.font = "bold 6px monospace";
        ctx.textAlign = "center";
        ctx.fillText(p.title, 0, -p.h / 2 + 9);
        if (p.torn) {
          // dog-eared corner peeling off the wall
          ctx.fillStyle = "#2a1731";
          ctx.beginPath();
          ctx.moveTo(p.w / 2, p.h / 2);
          ctx.lineTo(p.w / 2 - 9, p.h / 2);
          ctx.lineTo(p.w / 2, p.h / 2 - 9);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = "rgba(232,221,202,0.6)";
          ctx.beginPath();
          ctx.moveTo(p.w / 2 - 9, p.h / 2);
          ctx.lineTo(p.w / 2, p.h / 2 - 9);
          ctx.lineTo(p.w / 2 - 3, p.h / 2 - 3);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      }
      ctx.textAlign = "left";

      // neon sign blinks like tired 90s tubing
      const neonOn = Math.floor(animTimer / 30) % 11 !== 7;
      ctx.textAlign = "center";
      ctx.font = "bold 30px sans-serif";
      ctx.fillStyle = neonOn ? "#ff5c8a" : "rgba(255,92,138,0.25)";
      ctx.shadowColor = "#ff5c8a";
      ctx.shadowBlur = neonOn ? 18 : 4;
      ctx.fillText("오락실", CANVAS_W / 2, 106);
      ctx.font = "bold 13px monospace";
      ctx.fillStyle = neonOn ? "#59d8ff" : "rgba(89,216,255,0.25)";
      ctx.shadowColor = "#59d8ff";
      ctx.shadowBlur = neonOn ? 10 : 3;
      ctx.fillText("SINCE 1997", CANVAS_W / 2, 126);
      ctx.shadowBlur = 0;
      ctx.restore();

      // --- cabinet row (mid layer): the other machines keep running ---
      ctx.save();
      ctx.translate(layerShift(0.45), 0);
      // the coin feeder actually gets to play: the dead racer springs to life
      const feederT = animTimer % 1100;
      const feederPlaying = feederT >= 300 && feederT < 900;
      for (let ci = 0; ci < CABINETS.length; ci++) {
        const c = CABINETS[ci];
        const top = 168 + c.dy;
        const bottom = 324;
        const effMode: CabinetMode = ci === 2 && feederPlaying ? "demo" : c.mode;
        ctx.fillStyle = "#241222";
        ctx.fillRect(c.x, top, c.w, bottom - top);
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(c.x + c.w - 14, top, 14, bottom - top);
        // side art sticker strip
        ctx.fillStyle = c.marquee;
        ctx.globalAlpha = 0.5;
        ctx.fillRect(c.x + 2, top + 30, 5, bottom - top - 60);
        ctx.globalAlpha = 1;
        // years of grime: scuffed patches, a worn bright edge, one taped repair
        ctx.fillStyle = "rgba(0,0,0,0.25)";
        ctx.fillRect(c.x + 8 + ((ci * 13) % 30), bottom - 38, 24, 12);
        ctx.fillRect(c.x + c.w - 44, bottom - 88, 18, 8);
        ctx.fillStyle = "rgba(255,255,255,0.05)";
        ctx.fillRect(c.x + 8, top + 60, 3, bottom - top - 100);
        if (ci === 1) {
          ctx.fillStyle = "rgba(210,200,170,0.5)";
          ctx.fillRect(c.x + c.w - 34, top + 118, 22, 5);
          ctx.fillRect(c.x + c.w - 27, top + 111, 5, 20);
        }
        // marquee
        ctx.fillStyle = c.marquee;
        ctx.fillRect(c.x + 6, top + 4, c.w - 12, 16);
        ctx.fillStyle = "#1a0d18";
        ctx.font = "bold 11px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(c.name, c.x + c.w / 2, top + 16);
        // bezel + running screen
        ctx.fillStyle = "#100818";
        ctx.fillRect(c.x + 10, top + 24, c.w - 20, 64);
        drawCabinetScreen(c, ci, c.x + 14, top + 28, c.w - 28, 56, effMode);
        // maker badge on the bezel
        ctx.fillStyle = "rgba(255,255,255,0.5)";
        ctx.font = "bold 7px monospace";
        ctx.textAlign = "left";
        ctx.fillText("SNK", c.x + 14, top + 94);
        // screen light spilling onto the wall (off screens spill nothing)
        if (effMode !== "off") {
          ctx.globalAlpha = effMode === "dim" ? 0.04 : 0.08;
          ctx.fillStyle = c.screen;
          ctx.fillRect(c.x - 6, top + 16, c.w + 12, 84);
          ctx.globalAlpha = 1;
        }
        // light pollution: the screen color washes onto the floor below,
        // with a visible CRT throw cone falling from the screen to the pool
        if (effMode !== "off") {
          const flickDrop = effMode === "flicker" && (animTimer * 7 + ci * 31) % 90 < 5;
          const glowA = flickDrop ? 0.02 : effMode === "dim" ? 0.03 : 0.07;
          const gcx = c.x + c.w / 2;
          const cone = ctx.createLinearGradient(0, top + 86, 0, GROUND_SCREEN_Y + 16);
          cone.addColorStop(0, c.screen);
          cone.addColorStop(1, "rgba(0,0,0,0)");
          ctx.globalAlpha = glowA * 0.8;
          ctx.fillStyle = cone;
          ctx.beginPath();
          ctx.moveTo(c.x + 14, top + 86);
          ctx.lineTo(c.x + c.w - 14, top + 86);
          ctx.lineTo(gcx + 84, GROUND_SCREEN_Y + 16);
          ctx.lineTo(gcx - 84, GROUND_SCREEN_Y + 16);
          ctx.closePath();
          ctx.fill();
          const fg = ctx.createRadialGradient(gcx, GROUND_SCREEN_Y + 12, 8, gcx, GROUND_SCREEN_Y + 12, 90);
          fg.addColorStop(0, c.screen);
          fg.addColorStop(1, "rgba(0,0,0,0)");
          ctx.globalAlpha = glowA;
          ctx.fillStyle = fg;
          ctx.beginPath();
          ctx.ellipse(gcx, GROUND_SCREEN_Y + 14, 88, 26, 0, 0, Math.PI * 2);
          ctx.fill();
          ctx.globalAlpha = 1;
        }
        // control deck: joystick + buttons
        ctx.fillStyle = "#31182c";
        ctx.fillRect(c.x + 4, top + 96, c.w - 8, 18);
        ctx.fillStyle = "#0d0712";
        ctx.fillRect(c.x + 26, top + 96, 3, 8); // stick
        ctx.beginPath();
        ctx.arc(c.x + 27.5, top + 94, 4, 0, Math.PI * 2); // ball top
        ctx.fillStyle = "#c03a4a";
        ctx.fill();
        ctx.fillStyle = "#ff5c5c";
        ctx.fillRect(c.x + 48, top + 102, 6, 6);
        ctx.fillStyle = "#ffd54d";
        ctx.fillRect(c.x + 60, top + 102, 6, 6);
        // front panel: coin door with a blinking credit lamp
        ctx.fillStyle = "#1d0f1c";
        ctx.fillRect(c.x + c.w / 2 - 16, top + 132, 32, 42);
        ctx.fillStyle = "#0a0510";
        ctx.fillRect(c.x + c.w / 2 - 4, top + 140, 8, 12);
        ctx.strokeStyle = "#8a6a40";
        ctx.strokeRect(c.x + c.w / 2 - 4, top + 140, 8, 12);
        if ((animTimer + ci * 50) % 160 < 80) {
          ctx.fillStyle = "#ff5c5c";
          ctx.fillRect(c.x + c.w / 2 - 1.5, top + 160, 3, 3);
        }
      }

      // --- people at the machines: this arcade is open for business ---
      // At 8+ wins the machines empty out — everyone has drifted over to
      // watch the streak instead (they reappear in the crowd knots).
      const houseWatching = winStreak >= 8;
      const bigMoment = superInFlight() !== null || koZoomFrames > 0;

      // back-view player working a stick; on a super/KO they stop mashing
      // and crane their head around toward the noise; on a KO an arm goes up
      const drawPlayer = (px: number, seed: number, elbowRight: boolean) => {
        const feet = 332;
        const mash = bigMoment ? 0 : Math.sin(animTimer * 0.6 + seed) * 2.5;
        const lean = Math.sin(animTimer * 0.045 + seed) * 2;
        const headTurn = bigMoment ? (px < CANVAS_W / 2 ? 5 : -5) : 0;
        ctx.fillStyle = "#0b0610";
        ctx.fillRect(px - 8, feet - 34, 6, 34);
        ctx.fillRect(px + 2, feet - 34, 6, 34);
        ctx.beginPath();
        ctx.moveTo(px - 11 + lean, feet - 34);
        ctx.lineTo(px - 9 + lean, feet - 70);
        ctx.lineTo(px + 9 + lean, feet - 70);
        ctx.lineTo(px + 11 + lean, feet - 34);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.arc(px + lean + headTurn, feet - 77, 7, 0, Math.PI * 2);
        ctx.fill();
        if (koZoomFrames > 0) {
          ctx.fillRect(px + (elbowRight ? 10 : -14) + lean, feet - 92, 4, 20); // arm shoots up
        } else {
          const ex = elbowRight ? px + 9 + lean : px - 17 + lean;
          ctx.fillRect(ex, feet - 60 + mash, 8, 5);
        }
      };

      if (!houseWatching) {
        drawPlayer(CABINETS[0].x + CABINETS[0].w / 2 - 4, 0, true);
        drawPlayer(CABINETS[4].x + CABINETS[4].w / 2 + 4, 3.1, false);

        // the next challenger, leaning on the fighter cab with a tapping foot
        const tap = Math.floor(animTimer / 22) % 5 === 0 ? 2 : 0;
        ctx.fillStyle = "#0c0711";
        ctx.beginPath();
        ctx.moveTo(146, 302);
        ctx.lineTo(152, 262);
        ctx.lineTo(160, 264);
        ctx.lineTo(156, 303);
        ctx.closePath();
        ctx.fill();
        ctx.beginPath();
        ctx.arc(153 + (bigMoment ? 4 : 0), 256, 6.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillRect(147, 302, 5, 30);
        ctx.fillRect(155, 304, 5, 28 - tap);

        // coin feeder: walks up, feeds the dead racer, then plays for a bit
        if (feederT < 300) {
          const c2 = CABINETS[2];
          const doorX = c2.x + c2.w / 2;
          const bend = feederT < 60 ? feederT / 60 : feederT > 240 ? (300 - feederT) / 60 : 1;
          const px = doorX + 30;
          const feet = 332;
          ctx.fillStyle = "#0b0610";
          ctx.fillRect(px - 3, feet - 30, 5, 30);
          ctx.fillRect(px + 3, feet - 30, 5, 30);
          ctx.beginPath();
          ctx.moveTo(px - 6, feet - 30);
          ctx.lineTo(px - 6 - bend * 10, feet - 56 + bend * 8);
          ctx.lineTo(px + 6 - bend * 10, feet - 58 + bend * 8);
          ctx.lineTo(px + 8, feet - 30);
          ctx.closePath();
          ctx.fill();
          ctx.beginPath();
          ctx.arc(px - bend * 14, feet - 62 + bend * 9, 6.5, 0, Math.PI * 2);
          ctx.fill();
          if (bend > 0.8) {
            ctx.fillRect(doorX + 6, 306 + c2.dy, px - doorX - 12, 4);
            if (feederT % 30 < 15) {
              ctx.fillStyle = "#ffd54d";
              ctx.fillRect(doorX + 2, 308 + c2.dy, 3, 3);
            }
          }
        } else if (feederPlaying) {
          drawPlayer(CABINETS[2].x + CABINETS[2].w / 2, 1.7, true);
        }
      }
      ctx.restore();

      // smoky arcade air: haze bands under the lamps + slow drifting motes
      ctx.save();
      ctx.translate(layerShift(0.55), 0);
      for (const hzy of [64, 148]) {
        const hz = ctx.createLinearGradient(0, hzy, 0, hzy + 48);
        hz.addColorStop(0, "rgba(255,240,220,0)");
        hz.addColorStop(0.5, "rgba(255,240,220,0.05)");
        hz.addColorStop(1, "rgba(255,240,220,0)");
        ctx.fillStyle = hz;
        ctx.fillRect(-60, hzy, CANVAS_W + 120, 48);
      }
      ctx.fillStyle = "rgba(255,245,230,0.07)";
      for (let i = 0; i < 16; i++) {
        const mx = ((i * 167 + animTimer * (0.15 + (i % 3) * 0.08)) % (CANVAS_W + 40)) - 20;
        const my = 56 + ((i * 97 + animTimer * 0.06 * (1 + (i % 4))) % 270);
        ctx.fillRect(mx, my, 2, 2);
      }

      // light zoning: dark pockets between the lamps, a lift underneath them
      for (const dx of [268, 528]) {
        const dark = ctx.createLinearGradient(dx - 60, 0, dx + 60, 0);
        dark.addColorStop(0, "rgba(0,0,0,0)");
        dark.addColorStop(0.5, "rgba(0,0,0,0.16)");
        dark.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = dark;
        ctx.fillRect(dx - 60, 44, 120, GROUND_SCREEN_Y - 44);
      }
      for (const lx of [156, 416, 666]) {
        const lite = ctx.createLinearGradient(lx - 70, 0, lx + 70, 0);
        lite.addColorStop(0, "rgba(255,240,215,0)");
        lite.addColorStop(0.5, "rgba(255,240,215,0.045)");
        lite.addColorStop(1, "rgba(255,240,215,0)");
        ctx.fillStyle = lite;
        ctx.fillRect(lx - 70, 44, 140, GROUND_SCREEN_Y - 44);
      }
      ctx.restore();

      // --- onlookers: knots of pure-black silhouettes behind the rail.
      // Bodies overlap into a single mass per knot; heights vary. Each person
      // has their own reaction: 0 = jumper, 1 = arms up, 2 = leaner,
      // 3 = back-row peeker. On a KO everyone surges forward.
      const hype = crowdHype > 0 ? Math.min(1, crowdHype / 60) : 0;
      const superLive = superInFlight() !== null;
      const koSurge = koZoomFrames > 0;
      // at 8+ wins the whole arcade abandons its machines to watch you
      const crowdCount = winStreak >= 8 ? CROWD_ORDER.length : Math.min(CROWD_ORDER.length, 5 + Math.floor(winStreak * 0.7));
      ctx.save();
      ctx.translate(layerShift(0.7), 0);

      // passing NPC — a kid wanders in from the right, stops for a look, moves on
      {
        const nt = animTimer % 1800;
        if (nt < 1140) {
          let nx: number;
          let walking = true;
          if (nt < 300) nx = CANVAS_W + 30 - nt * 1.1;
          else if (nt < 640) {
            nx = CANVAS_W + 30 - 330;
            walking = false; // stopped, watching the match
          } else nx = CANVAS_W + 30 - 330 - (nt - 640) * 1.1;
          const step = walking ? Math.sin(nt * 0.25) : 0;
          const ny = 334 + (walking ? Math.abs(step) * 1.5 : Math.sin(nt * 0.05) * 1);
          ctx.fillStyle = "#0f0912";
          ctx.beginPath(); // small head
          ctx.arc(nx, ny - 30, 6, 0, Math.PI * 2);
          ctx.fill();
          ctx.beginPath(); // torso
          ctx.moveTo(nx - 9, ny);
          ctx.quadraticCurveTo(nx - 9, ny - 22, nx, ny - 25);
          ctx.quadraticCurveTo(nx + 9, ny - 22, nx + 9, ny);
          ctx.closePath();
          ctx.fill();
          if (walking) {
            ctx.fillRect(nx - 5 + step * 4, ny - 4, 4, 10);
            ctx.fillRect(nx + 1 - step * 4, ny - 4, 4, 10);
          }
        }
      }

      // two regulars chatting in the back corner, half-watching the match —
      // once the streak gets serious they stop chatting and face the fight
      {
        const engrossed = winStreak >= 8;
        const nodA = Math.sin(animTimer * 0.06) * 1.5;
        const nodB = Math.sin(animTimer * 0.06 + 2.5) * 1.5;
        ctx.fillStyle = "#0d0710";
        for (const [gx, nod, faceDir] of (engrossed
          ? [
              [704, nodA, -1],
              [724, nodB, -1],
            ]
          : [
              [704, nodA, 1],
              [724, nodB, -1],
            ]) as Array<[number, number, number]>) {
          ctx.beginPath();
          ctx.moveTo(gx - 8, 330);
          ctx.quadraticCurveTo(gx - 8, 306, gx, 303);
          ctx.quadraticCurveTo(gx + 8, 306, gx + 8, 330);
          ctx.closePath();
          ctx.fill();
          ctx.beginPath();
          ctx.arc(gx + faceDir * 2, 296 + nod, 6, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // draw back rows first so front bodies overlap them into one mass
      const visible = CROWD_ORDER.slice(0, crowdCount);
      for (const spot of [...visible.filter((s) => s.back), ...visible.filter((s) => !s.back)]) {
        const n = CROWD_ORDER.indexOf(spot);
        const scale = (spot.back ? 0.82 : 1) * spot.h;
        const feetY = spot.back ? 328 : 338;
        const sway = Math.sin(animTimer * 0.045 + n * 2.3) * (1.2 + hype * 2);
        let jump = 0;
        let lean = 0;
        let rise = 0;
        if (spot.reaction === 0 && (koSurge || hype > 0.5)) {
          jump = Math.abs(Math.sin(animTimer * 0.22 + n * 1.4)) * (koSurge ? 9 : 5 * hype);
        } else if (spot.reaction === 2 && superLive) {
          lean = -5; // flinches back from the flash
        } else if (spot.reaction === 3 && (superLive || hype > 0.4)) {
          rise = 6; // back-row peeker cranes over the shoulders
        }
        if (koSurge) lean += spot.x < CANVAS_W / 2 ? 4 : -4; // everyone surges toward the action
        const cx = spot.x + sway;
        const cy = feetY - jump - rise;
        ctx.fillStyle = spot.back ? "#0d0710" : "#070309";
        // shoulders
        ctx.beginPath();
        ctx.moveTo(cx - 14 * scale, cy);
        ctx.quadraticCurveTo(cx - 14 * scale, cy - 26 * scale, cx - 5 * scale, cy - 30 * scale);
        ctx.lineTo(cx + 5 * scale, cy - 30 * scale);
        ctx.quadraticCurveTo(cx + 14 * scale, cy - 26 * scale, cx + 14 * scale, cy);
        ctx.closePath();
        ctx.fill();
        // head
        ctx.beginPath();
        ctx.arc(cx + lean, cy - 37 * scale, 7.5 * scale, 0, Math.PI * 2);
        ctx.fill();
        // arms up: the designated cheerers, or everyone when it erupts
        if ((spot.reaction === 1 && hype > 0.3) || koSurge) {
          const wave = Math.sin(animTimer * 0.3 + n * 2) * 3;
          ctx.fillRect(cx - 16 * scale, cy - 46 * scale + wave, 3.5, 16);
          ctx.fillRect(cx + 12.5 * scale, cy - 46 * scale - wave, 3.5, 16);
        }
      }

      // crowd chatter bubbles float up over the heads
      for (const b of bubbles) {
        const t = b.life / b.maxLife;
        const bx = b.x;
        const by = 282 - t * 14;
        ctx.globalAlpha = t < 0.15 ? t / 0.15 : 1 - Math.max(0, (t - 0.7) / 0.3);
        ctx.font = "bold 11px sans-serif";
        const tw = ctx.measureText(b.text).width;
        ctx.fillStyle = "rgba(16,8,20,0.85)";
        ctx.strokeStyle = "rgba(255,255,255,0.55)";
        ctx.lineWidth = 1;
        ctx.fillRect(bx - tw / 2 - 7, by - 12, tw + 14, 18);
        ctx.strokeRect(bx - tw / 2 - 7, by - 12, tw + 14, 18);
        ctx.fillStyle = "#ffe9c9";
        ctx.textAlign = "center";
        ctx.fillText(b.text, bx, by + 1);
        ctx.globalAlpha = 1;
      }
      ctx.restore();
      ctx.textAlign = "left";

      // --- guardrail between the crowd and the floor ---
      ctx.save();
      ctx.translate(layerShift(0.88), 0);
      ctx.fillStyle = "#1b0f1e";
      for (let px = 24; px < CANVAS_W + 60; px += 96) {
        ctx.fillRect(px, 326, 5, 30);
      }
      for (const ry of [328, 342]) {
        ctx.fillStyle = "#3d2a42";
        ctx.fillRect(-40, ry, CANVAS_W + 80, 4);
        ctx.fillStyle = "rgba(255,220,180,0.28)"; // dull steel highlight
        ctx.fillRect(-40, ry, CANVAS_W + 80, 1.5);
      }
      ctx.restore();

      // --- arcade floor: dark worn tile with a light pool where they fight ---
      const floor = ctx.createLinearGradient(0, GROUND_SCREEN_Y, 0, CANVAS_H);
      floor.addColorStop(0, "#241a2e");
      floor.addColorStop(0.4, "#1c1424");
      floor.addColorStop(1, "#120c18");
      ctx.fillStyle = floor;
      ctx.fillRect(0, GROUND_SCREEN_Y, CANVAS_W, CANVAS_H - GROUND_SCREEN_Y);

      const pool = ctx.createRadialGradient(CANVAS_W / 2, GROUND_SCREEN_Y + 10, 20, CANVAS_W / 2, GROUND_SCREEN_Y + 10, 330);
      pool.addColorStop(0, "rgba(255,200,140,0.16)");
      pool.addColorStop(1, "rgba(255,200,140,0)");
      ctx.fillStyle = pool;
      ctx.fillRect(0, GROUND_SCREEN_Y, CANVAS_W, CANVAS_H - GROUND_SCREEN_Y);

      // tile seams receding toward a vanishing point
      ctx.strokeStyle = "rgba(200,180,220,0.08)";
      ctx.lineWidth = 1;
      const vpX = CANVAS_W / 2;
      for (let i = -5; i <= 5; i++) {
        ctx.beginPath();
        ctx.moveTo(vpX + i * 46, GROUND_SCREEN_Y);
        ctx.lineTo(vpX + i * 175, CANVAS_H);
        ctx.stroke();
      }
      for (const ly of [GROUND_SCREEN_Y + 16, GROUND_SCREEN_Y + 40]) {
        ctx.beginPath();
        ctx.moveTo(0, ly);
        ctx.lineTo(CANVAS_W, ly);
        ctx.stroke();
      }

      // floor life: 5 pieces of litter, reshuffled every round — cans, coins,
      // cigarette butts, game tokens, cups, flyers
      for (let li = 0; li < 5; li++) {
        const p1 = (((roundNumber * 7919 + li * 2971) % 997) + 997) % 997 / 997;
        const p2 = (((roundNumber * 5741 + li * 4409) % 991) + 991) % 991 / 991;
        const lx = 46 + p1 * (CANVAS_W - 92);
        const ly = GROUND_SCREEN_Y + 22 + p2 * 44;
        const kind = (li + roundNumber) % 6;
        if (kind === 0) {
          // crushed soda can
          ctx.fillStyle = "#b03040";
          ctx.fillRect(lx, ly, 9, 5);
          ctx.fillStyle = "rgba(255,255,255,0.35)";
          ctx.fillRect(lx + 1, ly + 1, 3, 1);
        } else if (kind === 1) {
          // 100-won coin catching the light now and then
          ctx.fillStyle = Math.floor(animTimer / 40) % 6 === 0 ? "#fff2b0" : "#c9a63a";
          ctx.beginPath();
          ctx.ellipse(lx, ly, 3, 1.5, 0, 0, Math.PI * 2);
          ctx.fill();
        } else if (kind === 2) {
          // cigarette butt with a faint amber tip
          ctx.fillStyle = "#d8d0c0";
          ctx.fillRect(lx, ly, 5, 2);
          ctx.fillStyle = "#c06a3a";
          ctx.fillRect(lx + 5, ly, 1.5, 2);
        } else if (kind === 3) {
          // brass game token, duller than money
          ctx.fillStyle = "#8a7a4a";
          ctx.beginPath();
          ctx.ellipse(lx, ly, 3, 1.5, 0, 0, Math.PI * 2);
          ctx.fill();
        } else if (kind === 4) {
          // paper cup on its side
          ctx.fillStyle = "#ddd6c8";
          ctx.beginPath();
          ctx.moveTo(lx, ly);
          ctx.lineTo(lx + 10, ly - 2);
          ctx.lineTo(lx + 11, ly + 4);
          ctx.lineTo(lx + 1, ly + 5);
          ctx.closePath();
          ctx.fill();
        } else {
          // dropped flyer
          ctx.save();
          ctx.translate(lx, ly);
          ctx.rotate(-0.3 + p1 * 0.6);
          ctx.fillStyle = "rgba(226,218,200,0.8)";
          ctx.fillRect(-9, -6, 18, 12);
          ctx.fillStyle = "rgba(120,40,60,0.6)";
          ctx.fillRect(-6, -3, 12, 2);
          ctx.fillRect(-6, 1, 8, 1.5);
          ctx.restore();
        }
      }
      // an empty green soda bottle by the rail, every round
      ctx.fillStyle = "#3a6a4a";
      ctx.fillRect(38, GROUND_SCREEN_Y + 14, 4, 9);
      ctx.fillRect(39, GROUND_SCREEN_Y + 10, 2, 4);

      // floor edge under the rail
      ctx.strokeStyle = "rgba(255,200,150,0.3)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, GROUND_SCREEN_Y);
      ctx.lineTo(CANVAS_W, GROUND_SCREEN_Y);
      ctx.stroke();
      ctx.textAlign = "left";
    }

    function drawParticles() {
      for (const p of particles) {
        const fade = 1 - p.life / p.maxLife;
        ctx.globalAlpha = fade;
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
      ctx.globalAlpha = 1;
    }

    function drawShockwaves() {
      for (const sw of shockwaves) {
        const t = sw.life / sw.maxLife;
        const rx = (sw.big ? 70 : 44) * (0.3 + t * 0.9);
        const ry = rx * 0.22;
        ctx.globalAlpha = (1 - t) * 0.8;
        ctx.strokeStyle = "#ffdcb0";
        ctx.lineWidth = sw.big ? 3 : 2;
        ctx.beginPath();
        ctx.ellipse(sw.x, GROUND_SCREEN_Y + 4, rx, ry, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = (1 - t) * 0.3;
        ctx.beginPath();
        ctx.ellipse(sw.x, GROUND_SCREEN_Y + 4, rx * 0.7, ry * 0.7, 0, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    // Re-drawn crisp ABOVE the depth blur: the signage a player's eye should
    // land on. Marquee titles stay legible, and the 오락실 sign burns through
    // with an additive neon bloom.
    function drawSharpAccents() {
      ctx.save();
      ctx.translate(layerShift(0.45), 0);
      ctx.textAlign = "center";
      ctx.font = "bold 11px sans-serif";
      for (const c of CABINETS) {
        const top = 168 + c.dy;
        ctx.fillStyle = c.marquee;
        ctx.fillRect(c.x + 6, top + 4, c.w - 12, 16);
        ctx.fillStyle = "#1a0d18";
        ctx.fillText(c.name, c.x + c.w / 2, top + 16);
      }
      ctx.restore();

      ctx.save();
      ctx.translate(layerShift(0.2), 0);
      const neonOn = Math.floor(animTimer / 30) % 11 !== 7;
      ctx.textAlign = "center";
      ctx.globalCompositeOperation = "lighter";
      ctx.font = "bold 30px sans-serif";
      ctx.shadowColor = "#ff5c8a";
      // bloom: a wide soft pass, then a hot tight core
      ctx.shadowBlur = neonOn ? 26 : 6;
      ctx.fillStyle = neonOn ? "rgba(255,110,150,0.75)" : "rgba(255,92,138,0.15)";
      ctx.fillText("오락실", CANVAS_W / 2, 106);
      ctx.shadowBlur = neonOn ? 12 : 3;
      ctx.fillStyle = neonOn ? "#ffd2e0" : "rgba(255,92,138,0.25)";
      ctx.fillText("오락실", CANVAS_W / 2, 106);
      ctx.font = "bold 13px monospace";
      ctx.shadowColor = "#59d8ff";
      ctx.shadowBlur = neonOn ? 14 : 3;
      ctx.fillStyle = neonOn ? "#a8ecff" : "rgba(89,216,255,0.25)";
      ctx.fillText("SINCE 1997", CANVAS_W / 2, 126);
      ctx.restore();
      ctx.textAlign = "left";
    }

    // Foreground parallax: dark corners of the neighboring cabinets frame the
    // shot and move faster than the world — instant depth.
    function drawForeground() {
      ctx.save();
      ctx.translate(layerShift(1.3), 0);
      ctx.filter = "blur(2.5px)"; // closest layer sits deepest out of focus
      ctx.globalAlpha = 0.92;
      ctx.fillStyle = "#0b0510";
      ctx.beginPath();
      ctx.moveTo(-34, CANVAS_H + 20);
      ctx.lineTo(-34, 150);
      ctx.lineTo(44, 192);
      ctx.lineTo(56, CANVAS_H + 20);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(CANVAS_W + 34, CANVAS_H + 20);
      ctx.lineTo(CANVAS_W + 34, 168);
      ctx.lineTo(CANVAS_W - 42, 206);
      ctx.lineTo(CANVAS_W - 54, CANVAS_H + 20);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.restore();
    }

    function drawCallouts() {
      for (const c of callouts) {
        const t = c.life / c.maxLife;
        ctx.globalAlpha = t < 0.1 ? t / 0.1 : 1 - Math.max(0, (t - 0.6) / 0.4);
        ctx.font = "bold 15px sans-serif";
        ctx.textAlign = "center";
        ctx.strokeStyle = "rgba(20,8,10,0.9)";
        ctx.lineWidth = 3;
        const y = c.y - t * 10;
        ctx.strokeText(c.text, c.x, y);
        ctx.fillStyle = c.color;
        ctx.fillText(c.text, c.x, y);
      }
      ctx.globalAlpha = 1;
      ctx.textAlign = "left";
    }

    /** A fighter whose super is currently in startup/active frames, if any. */
    function superInFlight(): Fighter | null {
      const def = ATTACKS.super;
      for (const f of [world.player, world.opponent]) {
        if (f.action === "attack" && f.attackId === "super" && f.actionFrame <= def.startup + def.active + 4) {
          return f;
        }
      }
      return null;
    }

    function draw() {
      ctx.save();
      if (shakeFrames > 0) {
        const decay = shakeFrames / 10;
        ctx.translate(
          (Math.random() * 2 - 1) * shakeMag * decay,
          (Math.random() * 2 - 1) * shakeMag * decay
        );
      }

      // camera: ease toward the midpoint of the fighters, zooming with proximity.
      // On KO it rushes in hard on the loser instead.
      const pX = world.player.x * SCALE;
      const oX = world.opponent.x * SCALE;
      const proximity = Math.max(0, Math.min(1, 1 - Math.abs(pX - oX) / (CANVAS_W * 0.65)));
      const koCinema = koFocusId !== null && koPendingFrames >= 0;
      const koBoost = koCinema ? 0.35 : koZoomFrames > 0 ? (koZoomFrames / 45) * 0.2 : 0;
      const targetZ = Math.min(1.5, 1.02 + proximity * 0.14 + koBoost);
      camZ += (targetZ - camZ) * (koCinema ? 0.22 : 0.08);
      const halfW = CANVAS_W / (2 * camZ);
      const focusX = koCinema && koFocusId ? world[koFocusId].x * SCALE : (pX + oX) / 2;
      const targetX = Math.max(halfW, Math.min(CANVAS_W - halfW, focusX));
      camX += (targetX - camX) * (koCinema ? 0.2 : 0.1);
      camX = Math.max(halfW, Math.min(CANVAS_W - halfW, camX));
      const camY = CANVAS_H - CANVAS_H / (2 * camZ); // hug the ground so the road stays in frame
      ctx.translate(CANVAS_W / 2, CANVAS_H / 2);
      ctx.scale(camZ, camZ);
      ctx.translate(-camX, -camY);

      // depth of field: the background renders offscreen, then the wall half
      // is stamped back with a light blur — focus does the separating, not
      // darkness. Only a whisper of a dark wash (6%) remains, so the room
      // stays readable. The floor they stand on stays sharp.
      const mainCtx = ctx;
      ctx = bgCtx;
      drawBackground();
      ctx = mainCtx;
      ctx.filter = "blur(1.1px)";
      ctx.drawImage(bgCanvas, 0, 0, CANVAS_W, GROUND_SCREEN_Y, 0, 0, CANVAS_W, GROUND_SCREEN_Y);
      ctx.filter = "none";
      ctx.drawImage(
        bgCanvas,
        0,
        GROUND_SCREEN_Y,
        CANVAS_W,
        CANVAS_H - GROUND_SCREEN_Y,
        0,
        GROUND_SCREEN_Y,
        CANVAS_W,
        CANVAS_H - GROUND_SCREEN_Y
      );
      ctx.fillStyle = "rgba(0,0,0,0.06)";
      ctx.fillRect(0, 0, CANVAS_W, GROUND_SCREEN_Y);
      drawSharpAccents();

      // super cinematic: dim the street, spotlight whoever is unleashing it.
      // During the freeze frame (hit connects, world stops) it goes darkest —
      // only the fighters and the explosion read.
      const superFighter = superInFlight();
      if (superFighter) {
        ctx.fillStyle = superFreeze > 0 ? "rgba(4,2,14,0.82)" : "rgba(8,4,22,0.6)";
        ctx.fillRect(-80, -80, CANVAS_W + 160, CANVAS_H + 160);
        const sx = superFighter.x * SCALE;
        const sy = GROUND_SCREEN_Y - superFighter.y * SCALE - FIGURE_HEIGHT * 0.5;
        const spot = ctx.createRadialGradient(sx, sy, 20, sx, sy, 170);
        spot.addColorStop(0, "rgba(255,236,170,0.4)");
        spot.addColorStop(1, "rgba(255,236,170,0)");
        ctx.fillStyle = spot;
        ctx.fillRect(sx - 180, sy - 180, 360, 360);
      }

      // glossy floor: the fighters mirror faintly in the worn tile
      for (const f of [world.opponent, world.player]) {
        const pose = lastPose[f.id];
        if (!pose) continue;
        const reflY = GROUND_SCREEN_Y * 2 - pose.y; // mirror around the ground line
        drawSprite(pose.anim, pose.frame, pose.x, reflY, pose.facing, -0.8, 0.13, "blur(1px) brightness(0.6)");
      }

      // simple ground shadows
      for (const f of [world.player, world.opponent]) {
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.beginPath();
        ctx.ellipse(f.x * SCALE, GROUND_SCREEN_Y + 6, 34, 8, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      drawShockwaves();
      drawTrails();
      drawFighter(world.opponent, true);
      drawFighter(world.player, false);
      drawFlashes();
      drawParticles();
      drawCallouts();
      drawForeground();
      ctx.restore();

      // full-screen impact flash, drawn in screen space under the HUD
      if (screenFlash > 0) {
        ctx.fillStyle = `rgba(255,255,255,${(screenFlash / SCREEN_FLASH_MAX) * 0.5})`;
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
      }
      drawHud();
    }

    function startNextRoundOrEnd() {
      if (playerRounds >= ROUNDS_TO_WIN || opponentRounds >= ROUNDS_TO_WIN) {
        phase = "matchEnd";
        return;
      }
      roundNumber += 1;
      world = createWorld();
      ghostHp.player = MAX_HP;
      ghostHp.opponent = MAX_HP;
      ghostDelay.player = 0;
      ghostDelay.opponent = 0;
      trails = [];
      flashes = [];
      bubbles = [];
      shockwaves = [];
      callouts = [];
      slowmoFrames = 0;
      slowmoDiv = 3;
      koPendingFrames = -1;
      koFocusId = null;
      timeLeftFrames = ROUND_TIME_SECONDS * 60;
      phase = "intro";
      phaseTimer = 90;
    }

    function tick() {
      animTimer += 1;
      updateParticles();
      updateFlashes();
      updateTrails();
      if (comboTimer > 0) comboTimer -= 1;
      if (shakeFrames > 0) shakeFrames -= 1;
      if (screenFlash > 0) screenFlash -= 1;
      if (koZoomFrames > 0) koZoomFrames -= 1;
      if (crowdHype > 0) crowdHype -= 1;
      if (superFreeze > 0) superFreeze -= 1;
      bubbles = bubbles.filter((b) => {
        b.life += 1;
        return b.life < b.maxLife;
      });
      shockwaves = shockwaves.filter((sw) => {
        sw.life += 1;
        return sw.life < sw.maxLife;
      });
      callouts = callouts.filter((c) => {
        c.life += 1;
        return c.life < c.maxLife;
      });
      // ghost HP holds for a beat, then drains toward the real value
      for (const side of ["player", "opponent"] as const) {
        if (ghostDelay[side] > 0) ghostDelay[side] -= 1;
        else ghostHp[side] = Math.max(world[side].hp, ghostHp[side] - 1.1);
      }

      if (phase === "intro") {
        if (phaseTimer === 90) {
          sfx.roundStart();
          // a streak precedes you — the regulars talk before round 1
          if (roundNumber === 1) {
            if (winStreak >= 10) {
              crowdShoutText("고수다...");
              crowdShoutText("누구야?");
              crowdHype = 100;
            } else if (winStreak >= 5) {
              crowdShoutText("또 이겼어.");
              crowdHype = 70;
            } else if (winStreak >= 3) {
              crowdShoutText("쟤 잘한다.");
              crowdHype = 50;
            }
          }
        }
        phaseTimer -= 1;
        if (phaseTimer === 30 && !fightCalled) {
          fightCalled = true;
          sfx.fightCall();
        }
        if (phaseTimer <= 0) {
          phase = "fight";
          fightCalled = false;
        }
        return;
      }
      if (phase === "roundEnd") {
        phaseTimer -= 1;
        if (phaseTimer <= 0) startNextRoundOrEnd();
        return;
      }
      if (phase === "matchEnd") {
        if (!resultSounded) {
          resultSounded = true;
          const playerWon = playerRounds > opponentRounds;
          if (playerWon) sfx.win();
          else sfx.lose();
          const winner = playerWon ? world.player : world.opponent;
          gruntIdx += 1;
          fighterShout(winner, WIN_LINES[gruntIdx % WIN_LINES.length], "#ffe9c9");
          sfx.shout("win", !playerWon);
        }
        matchEndTimer -= 1;
        if (matchEndTimer <= 0 && !ended) {
          ended = true;
          onEndRef.current({
            won: playerRounds > opponentRounds,
            comeback: playerWasDown && playerRounds > opponentRounds,
            landedAntiAir,
            landedCombo,
          });
        }
        return;
      }

      if (hitstopFrames > 0) {
        hitstopFrames -= 1;
        return; // world frozen for impact weight; particles/shake still animate
      }

      // slow motion after the freeze: world steps at 1/slowmoDiv speed
      if (slowmoFrames > 0) {
        slowmoFrames -= 1;
        if (animTimer % slowmoDiv !== 0) return;
      }

      timeLeftFrames = Math.max(0, timeLeftFrames - 1);
      const playerInput = inputFromKeys();
      const opponentInput = tickAi(aiBrain, world.frame, world.opponent, world.player, opponent);
      const result = stepFight(world, playerInput, opponentInput);

      // fighter voice: bark on the first frame of every attack
      for (const f of [result.world.player, result.world.opponent]) {
        if (f.action === "attack" && f.actionFrame === 1 && f.attackId) {
          const isOpp = f.id === "opponent";
          if (f.attackId === "super") {
            gruntIdx += 1;
            fighterShout(f, SUPER_LINES[gruntIdx % SUPER_LINES.length], "#ffe14d");
            sfx.shout("super", isOpp);
          } else if (f.attackId === "hp" || f.attackId === "hk") {
            gruntIdx += 1;
            fighterShout(f, GRUNTS[gruntIdx % GRUNTS.length], isOpp ? "#9fe8ff" : "#ffd0c0");
            sfx.shout("heavy", isOpp);
          } else if (gruntIdx++ % 3 === 0) {
            sfx.shout("light", isOpp);
          }
        }
      }

      world = result.world;

      for (const ev of result.events) {
        const defender = ev.defender === "player" ? world.player : world.opponent;
        const heavy = ev.attackId === "hp" || ev.attackId === "hk";
        const point = impactPoint(defender);

        const isSuper = ev.attackId === "super";
        if (ev.type === "hit" || ev.type === "ko") {
          spawnSparks(
            point.x,
            point.y,
            isSuper ? ["#fff6c9", "#ffd54d", "#ff7a30", "#ffffff"] : ["#ffd54d", "#ff9040", "#ffffff"],
            isSuper ? 26 : heavy ? 14 : 9,
            isSuper ? 7 : heavy ? 5 : 3.5
          );
          spawnImpactFlash(
            point.x,
            point.y,
            isSuper ? 64 : heavy ? 44 : 28,
            isSuper ? "#ffd54d" : "#ffb060",
            heavy || isSuper
          );
          hitstopFrames = isSuper ? 12 : heavy ? 7 : 4;
          shakeFrames = isSuper ? 18 : heavy ? 10 : 5;
          shakeMag = isSuper ? 11 : heavy ? 7 : 4;
          ghostDelay[ev.defender] = 30;
          if (isSuper) {
            screenFlash = 9;
            superFreeze = 12; // freeze frame: pitch-black stage, fighters + blast only
            slowmoFrames = 14; // then the blow lands in slow motion
            slowmoDiv = 3;
            koZoomFrames = Math.max(koZoomFrames, 24);
            crowdHype = Math.max(crowdHype, 90);
            crowdShout(true);
            sfx.crowdCheer(2, 0.15);
          } else if (heavy) {
            screenFlash = 5;
            crowdHype = Math.max(crowdHype, 40);
          }
          sfx.hit((ev.attackId ?? "lp") as sfx.HitKind, panFor(point.x));
          if (ev.attacker === "player") {
            if (ev.defenderWasAirborne) landedAntiAir = true;
            const combo = ev.comboCount ?? 0;
            if (combo >= 3) landedCombo = true;
            if (combo >= 2) {
              comboShown = combo;
              comboTimer = 55;
              // the crowd swells as the combo grows
              if (combo === 3) sfx.crowdCheer(1);
              else if (combo === 5) sfx.crowdCheer(2);
              else if (combo === 8) sfx.crowdCheer(3);
              if (combo >= 4) {
                crowdHype = Math.max(crowdHype, 70);
                crowdShout(false);
              }
            }
          }
        } else if (ev.type === "block") {
          spawnSparks(point.x, point.y, ["#7fd8ff", "#cfeeff"], 6, 2.5);
          spawnImpactFlash(point.x, point.y, 22, "#8fdcff", false);
          hitstopFrames = 2;
          ghostDelay[ev.defender] = 30; // chip damage gets the same ghost treatment
          sfx.block(panFor(point.x));
        }

        if (ev.type === "ko") {
          // KO sound ritual: blast → dead silence → the crowd erupts
          sfx.koBlast(panFor(point.x));
          duckBgm(0.4);
          duckAmbience(0.4);
          sfx.crowdCheer(3, 0.5);
          hitstopFrames = 18; // long freeze sells the finishing blow
          shakeFrames = 16;
          shakeMag = 9;
          screenFlash = SCREEN_FLASH_MAX;
          koZoomFrames = 45;
          koFocusId = ev.defender; // camera rushes in on the loser
          crowdHype = 120;
          crowdShout(true);
          spawnImpactFlash(point.x, point.y, 100, "#ffffff", true);
        }

        // bodies hitting the pavement / bouncing off the corner
        if (ev.type === "land") {
          const lx = (ev.defender === "player" ? world.player.x : world.opponent.x) * SCALE;
          const big = (ev.impactVy ?? 0) < -7;
          shockwaves.push({ x: lx, life: 0, maxLife: big ? 22 : 16, big });
          spawnSparks(lx, GROUND_SCREEN_Y - 6, ["#c9a68a", "#8a7362", "#e8d9c4"], big ? 14 : 8, big ? 4 : 2.5);
          shakeFrames = Math.max(shakeFrames, big ? 10 : 5);
          shakeMag = Math.max(shakeMag, big ? 6 : 3);
          sfx.thud(Math.min(1, Math.abs(ev.impactVy ?? 5) / 11), panFor(lx));
        } else if (ev.type === "wallbounce") {
          const wf = ev.defender === "player" ? world.player : world.opponent;
          const wx = wf.x * SCALE;
          const wy = GROUND_SCREEN_Y - wf.y * SCALE - FIGURE_HEIGHT * 0.5;
          spawnImpactFlash(wx, wy, 30, "#cfd8ff", false);
          spawnSparks(wx, wy, ["#cfd8ff", "#8fa0c0"], 8, 3);
          shakeFrames = Math.max(shakeFrames, 6);
          shakeMag = Math.max(shakeMag, 4);
          sfx.wallClang(panFor(wx));
        }
      }

      // afterimage snapshots while a super is live
      if (animTimer % 2 === 0) {
        for (const f of [world.player, world.opponent]) {
          if (f.action === "attack" && f.attackId === "super") {
            const pose = lastPose[f.id];
            if (pose) trails.push({ ...pose, life: 0 });
          }
        }
      }

      const playerDown = world.player.action === "ko";
      const opponentDown = world.opponent.action === "ko";
      const timeUp = timeLeftFrames <= 0;
      if (playerDown || opponentDown || timeUp) {
        // On a knockout the loser flies and falls at 0.2x speed while the
        // camera rushes in, before the banner drops.
        if ((playerDown || opponentDown) && koPendingFrames === -1 && !timeUp) {
          koPendingFrames = 12; // counted in world steps: 12 × 5 ≈ 1s of real time
          slowmoFrames = 70;
          slowmoDiv = 5;
        }
        if (koPendingFrames > 0) {
          koPendingFrames -= 1;
          return;
        }
        koPendingFrames = -1;
        slowmoFrames = 0;
        const playerWonRound = playerDown ? false : opponentDown ? true : world.player.hp >= world.opponent.hp;
        if (playerWonRound) playerRounds += 1;
        else {
          opponentRounds += 1;
          if (playerRounds === 0) playerWasDown = true;
        }
        phase = "roundEnd";
        phaseTimer = 110; // a bit longer so the death animation reads
      }
    }

    const STEP_MS = 1000 / 60;
    let lastTime = 0;
    let accumulator = 0;

    function loop(t: number) {
      if (cancelled) return;
      if (!lastTime) lastTime = t;
      let delta = t - lastTime;
      lastTime = t;
      if (delta > 250) delta = 250;
      accumulator += delta;
      while (accumulator >= STEP_MS) {
        tick();
        accumulator -= STEP_MS;
      }
      draw();
      rafId = requestAnimationFrame(loop);
    }

    loadSheets()
      .then((loaded) => {
        if (cancelled) return;
        sheets = loaded;
        setAssetsReady(true);
        rafId = requestAnimationFrame(loop);
      })
      .catch(() => {
        // Sprite assets missing — leave the canvas blank rather than crash.
      });

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      stopBgm();
      stopAmbience();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [opponent, winStreak]);

  const press = (field: keyof FightInput, down: boolean) => {
    touchInputRef.current[field] = down;
    if (down) {
      sfx.unlock();
      startBgm();
      startAmbience();
    }
  };

  const touchBtn = (field: keyof FightInput, label: string, extra = "") => (
    <button
      key={field + label}
      className={`flex select-none items-center justify-center rounded-full border border-white/40 bg-white/10 text-sm font-bold text-white/90 backdrop-blur-[2px] active:bg-white/40 ${extra}`}
      style={{ touchAction: "none" }}
      onPointerDown={(e) => {
        e.preventDefault();
        press(field, true);
      }}
      onPointerUp={() => press(field, false)}
      onPointerLeave={() => press(field, false)}
      onPointerCancel={() => press(field, false)}
      onContextMenu={(e) => e.preventDefault()}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-col items-center gap-2">
      <div className="crt w-full max-w-[768px] overflow-hidden rounded border-2 border-arcade-neon shadow-neon">
        <canvas
          ref={canvasRef}
          width={CANVAS_W}
          height={CANVAS_H}
          className="block w-full"
          style={{ imageRendering: "pixelated", aspectRatio: `${CANVAS_W} / ${CANVAS_H}` }}
        />

        {isTouch && (
          <>
            {/* D-pad, bottom-left */}
            <div className="absolute bottom-2 left-2 z-20 grid grid-cols-3 gap-1">
              <div />
              {touchBtn("up", "▲", "h-11 w-11")}
              <div />
              {touchBtn("left", "◀", "h-11 w-11")}
              {touchBtn("down", "▼", "h-11 w-11")}
              {touchBtn("right", "▶", "h-11 w-11")}
            </div>
            {/* attack cluster, bottom-right */}
            <div className="absolute bottom-2 right-2 z-20 flex flex-col items-end gap-1">
              {touchBtn("super", "필살", "h-9 w-24 text-[11px] border-arcade-yellow/70 text-arcade-yellow")}
              <div className="grid grid-cols-2 gap-1">
                {touchBtn("lp", "약P", "h-11 w-11 text-[11px]")}
                {touchBtn("hp", "강P", "h-11 w-11 text-[11px]")}
                {touchBtn("lk", "약K", "h-11 w-11 text-[11px]")}
                {touchBtn("hk", "강K", "h-11 w-11 text-[11px]")}
              </div>
            </div>
          </>
        )}
      </div>
      {!assetsReady && <p className="text-xs text-arcade-cyan">스프라이트 불러오는 중...</p>}
      {!isTouch && (
        <p className="text-center text-[10px] leading-relaxed text-gray-400">
          ←→ 이동 · ↑ 점프 · ↓ 웅크리기 · Z 약공 · X 강공 · C 약발 · V 강발
          <br />
          상대 반대 방향으로 이동하면 막기(블록) · 기력 게이지 MAX 시 <span className="text-arcade-yellow">SPACE = 초필살기</span>
        </p>
      )}
      {isTouch && (
        <p className="text-center text-[10px] leading-relaxed text-gray-400">
          상대 반대 방향 ◀▶ = 막기 · 기력 MAX 시 필살 버튼
        </p>
      )}
    </div>
  );
}
