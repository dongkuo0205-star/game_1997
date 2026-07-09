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
    const ctx: CanvasRenderingContext2D = ctx2d;

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
    const CABINETS = [
      { x: 8, w: 132, screen: "#59d8ff", marquee: "#ff5c8a", name: "격투 97" },
      { x: 162, w: 132, screen: "#7dff8e", marquee: "#ffd54d", name: "슈팅" },
      { x: 316, w: 132, screen: "#ff9de2", marquee: "#59d8ff", name: "레이싱" },
      { x: 470, w: 132, screen: "#ffd27d", marquee: "#7dff8e", name: "퍼즐" },
      { x: 624, w: 136, screen: "#9fa8ff", marquee: "#ff8a5c", name: "야구" },
    ];
    const POSTERS = [
      { x: 58, y: 92, w: 34, h: 48, c: "#7a2f4a" },
      { x: 224, y: 86, w: 30, h: 44, c: "#2f4a7a" },
      { x: 668, y: 90, w: 32, h: 46, c: "#4a6a2f" },
    ];
    // irregular standing spots, not a parade line; `back` row stands deeper
    const CROWD_SPOTS = [
      { x: 120, back: false },
      { x: 208, back: true },
      { x: 318, back: false },
      { x: 262, back: true },
      { x: 452, back: false },
      { x: 560, back: true },
      { x: 648, back: false },
      { x: 96, back: true },
      { x: 388, back: true },
      { x: 508, back: false },
      { x: 596, back: false },
      { x: 170, back: false },
    ];

    /** Horizontal offset that makes a layer lag (factor < 1) or lead
     *  (factor > 1) the camera — cheap parallax depth. */
    function layerShift(factor: number): number {
      return (camX - CANVAS_W / 2) * (1 - factor);
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
      for (const tx of [150, 480]) {
        const flick = (animTimer + tx) % 240 > 6 ? 1 : 0.35; // tired fluorescent stutter
        ctx.fillStyle = `rgba(220,235,255,${0.12 * flick})`;
        ctx.fillRect(tx - 18, 30, 156, 26);
        ctx.fillStyle = `rgba(235,245,255,${0.9 * flick})`;
        ctx.fillRect(tx, 34, 120, 6);
      }

      for (const p of POSTERS) {
        ctx.fillStyle = p.c;
        ctx.fillRect(p.x, p.y, p.w, p.h);
        ctx.fillStyle = "rgba(255,255,255,0.25)";
        ctx.fillRect(p.x + 4, p.y + 5, p.w - 8, 10);
        ctx.strokeStyle = "rgba(0,0,0,0.5)";
        ctx.strokeRect(p.x, p.y, p.w, p.h);
      }

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
      for (let ci = 0; ci < CABINETS.length; ci++) {
        const c = CABINETS[ci];
        const top = 168;
        const bottom = 324;
        ctx.fillStyle = "#241222";
        ctx.fillRect(c.x, top, c.w, bottom - top);
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(c.x + c.w - 14, top, 14, bottom - top);
        // marquee
        ctx.fillStyle = c.marquee;
        ctx.fillRect(c.x + 6, top + 4, c.w - 12, 16);
        ctx.fillStyle = "#1a0d18";
        ctx.font = "bold 11px sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(c.name, c.x + c.w / 2, top + 16);
        // screen: alive — slow pulse, occasional attract-mode flash
        const pulse = 0.72 + Math.sin(animTimer * 0.03 + ci * 2.1) * 0.18;
        const attract = (animTimer + ci * 97) % 300 < 8;
        ctx.globalAlpha = attract ? 0.95 : pulse;
        ctx.fillStyle = attract ? "#ffffff" : c.screen;
        ctx.fillRect(c.x + 14, top + 28, c.w - 28, 56);
        ctx.globalAlpha = 0.08;
        ctx.fillStyle = c.screen; // spill onto the wall
        ctx.fillRect(c.x - 6, top + 16, c.w + 12, 84);
        ctx.globalAlpha = 1;
        // control deck + buttons
        ctx.fillStyle = "#31182c";
        ctx.fillRect(c.x + 4, top + 92, c.w - 8, 18);
        ctx.fillStyle = "#ff5c5c";
        ctx.fillRect(c.x + 24, top + 98, 5, 5);
        ctx.fillStyle = "#ffd54d";
        ctx.fillRect(c.x + 36, top + 98, 5, 5);
      }
      ctx.restore();

      // --- onlookers: a loose knot of pure-black silhouettes behind the rail.
      // Head and shoulders only. They sway, raise arms on combos, lean back
      // on supers and all jump on a KO. A win streak draws more of them in.
      const hype = crowdHype > 0 ? Math.min(1, crowdHype / 60) : 0;
      const superLean = superInFlight() !== null;
      const koJumping = koZoomFrames > 0;
      const crowdCount = Math.min(CROWD_SPOTS.length, 5 + Math.floor(winStreak * 0.7));
      ctx.save();
      ctx.translate(layerShift(0.7), 0);
      for (let n = 0; n < crowdCount; n++) {
        const spot = CROWD_SPOTS[n];
        const scale = spot.back ? 0.82 : 1;
        const feetY = spot.back ? 328 : 338;
        const sway = Math.sin(animTimer * 0.045 + n * 2.3) * (1.5 + hype * 2);
        const jump = koJumping
          ? Math.abs(Math.sin(animTimer * 0.22 + n * 1.4)) * 9
          : hype > 0.5 && n % 3 === 0
            ? Math.abs(Math.sin(animTimer * 0.2 + n)) * 5 * hype
            : 0;
        const lean = superLean ? -4 : 0;
        const cx = spot.x + sway;
        const cy = feetY - jump;
        ctx.fillStyle = spot.back ? "#0d0710" : "#070309";
        // shoulders
        ctx.beginPath();
        ctx.moveTo(cx - 13 * scale, cy);
        ctx.quadraticCurveTo(cx - 13 * scale, cy - 26 * scale, cx - 5 * scale, cy - 30 * scale);
        ctx.lineTo(cx + 5 * scale, cy - 30 * scale);
        ctx.quadraticCurveTo(cx + 13 * scale, cy - 26 * scale, cx + 13 * scale, cy);
        ctx.closePath();
        ctx.fill();
        // head
        ctx.beginPath();
        ctx.arc(cx + lean, cy - 37 * scale, 7.5 * scale, 0, Math.PI * 2);
        ctx.fill();
        // raised arms when the fight gets good
        if (hype > 0.4 || koJumping) {
          const wave = Math.sin(animTimer * 0.3 + n * 2) * 3;
          ctx.fillRect(cx - 15 * scale, cy - 46 * scale + wave, 3.5, 16);
          ctx.fillRect(cx + 11.5 * scale, cy - 46 * scale - wave, 3.5, 16);
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

    // Foreground parallax: dark corners of the neighboring cabinets frame the
    // shot and move faster than the world — instant depth.
    function drawForeground() {
      ctx.save();
      ctx.translate(layerShift(1.3), 0);
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

      drawBackground();

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
