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
import { startBgm, stopBgm } from "@/lib/fight/bgm";
import { startAmbience, stopAmbience } from "@/lib/fight/ambience";

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
}: {
  opponent: Opponent;
  onEnd: (result: FightMatchResult) => void;
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

    // Slow motion: the world steps at 1/3 speed while active. Used for the
    // final super hit and the KO fall.
    let slowmoFrames = 0;
    // KO is savored: the loser falls in slow motion before the banner drops.
    let koPendingFrames = -1;

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

    function crowdShout(big: boolean) {
      const pool = big ? CROWD_LINES_BIG : CROWD_LINES;
      crowdLineIdx += 1;
      bubbles.push({
        text: pool[(crowdLineIdx * 7 + (big ? 3 : 0)) % pool.length],
        x: 60 + ((crowdLineIdx * 173) % (CANVAS_W - 160)),
        life: 0,
        maxLife: 80,
      });
      if (bubbles.length > 3) bubbles = bubbles.slice(-3);
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

    // 1990s street at sunset — far skyline, near shops with signs, backlit crowd.
    const FAR_SKYLINE = [
      { x: 0, w: 90, h: 120 },
      { x: 80, w: 60, h: 150 },
      { x: 150, w: 100, h: 100 },
      { x: 260, w: 70, h: 135 },
      { x: 340, w: 110, h: 95 },
      { x: 460, w: 80, h: 145 },
      { x: 550, w: 100, h: 110 },
      { x: 660, w: 110, h: 130 },
    ];
    const SHOPS = [
      { x: -10, w: 150, h: 210, body: "#3a2233", sign: "만화방", signColor: "#ffd54d" },
      { x: 150, w: 120, h: 180, body: "#402638", sign: "분식", signColor: "#7fe3a0" },
      { x: 280, w: 150, h: 225, body: "#35203a", sign: "오락실", signColor: "#ff6e8e" },
      { x: 440, w: 130, h: 190, body: "#402b36", sign: "전파사", signColor: "#6fd3e0" },
      { x: 580, w: 200, h: 215, body: "#38222e", sign: "레코드", signColor: "#f2a35c" },
    ];

    function drawBackground() {
      // Sunset sky
      const sky = ctx.createLinearGradient(0, 0, 0, GROUND_SCREEN_Y);
      sky.addColorStop(0, "#2b1a4d");
      sky.addColorStop(0.4, "#75345f");
      sky.addColorStop(0.75, "#c85a50");
      sky.addColorStop(1, "#f0a05a");
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, CANVAS_W, GROUND_SCREEN_Y);

      // Setting sun with glow
      const sunX = CANVAS_W * 0.62;
      const sunY = GROUND_SCREEN_Y - 130;
      const glow = ctx.createRadialGradient(sunX, sunY, 8, sunX, sunY, 120);
      glow.addColorStop(0, "rgba(255,214,140,0.85)");
      glow.addColorStop(1, "rgba(255,214,140,0)");
      ctx.fillStyle = glow;
      ctx.fillRect(sunX - 130, sunY - 130, 260, 260);
      ctx.fillStyle = "#ffdf9e";
      ctx.beginPath();
      ctx.arc(sunX, sunY, 34, 0, Math.PI * 2);
      ctx.fill();

      // Thin dusk clouds
      ctx.fillStyle = "rgba(60,26,70,0.55)";
      ctx.fillRect(0, 70, CANVAS_W, 8);
      ctx.fillRect(120, 105, CANVAS_W - 200, 6);
      ctx.fillRect(40, 140, CANVAS_W - 320, 5);

      // Far skyline (haze-lit silhouettes)
      ctx.fillStyle = "#4a2547";
      for (const b of FAR_SKYLINE) {
        ctx.fillRect(b.x, GROUND_SCREEN_Y - 60 - b.h, b.w, b.h + 60);
      }

      // Near shop row
      for (const s of SHOPS) {
        const top = GROUND_SCREEN_Y - 40 - s.h;
        ctx.fillStyle = s.body;
        ctx.fillRect(s.x, top, s.w, s.h);
        // roofline
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(s.x, top, s.w, 8);
        // warm lit windows
        ctx.fillStyle = "#ffca6e";
        for (let wx = s.x + 12; wx < s.x + s.w - 14; wx += 22) {
          for (let wy = top + 20; wy < GROUND_SCREEN_Y - 110; wy += 30) {
            if ((wx * 5 + wy * 3) % 17 < 9) ctx.fillRect(wx, wy, 9, 12);
          }
        }
        // vertical hangul signboard with soft glow
        const signX = s.x + s.w - 26;
        const signTop = top + 26;
        const signH = s.sign.length * 24 + 14;
        ctx.fillStyle = "rgba(12,6,16,0.85)";
        ctx.fillRect(signX, signTop, 20, signH);
        ctx.textAlign = "center";
        ctx.font = "bold 15px sans-serif";
        ctx.fillStyle = s.signColor;
        ctx.shadowColor = s.signColor;
        ctx.shadowBlur = 8;
        for (let i = 0; i < s.sign.length; i++) {
          ctx.fillText(s.sign[i], signX + 10, signTop + 24 + i * 24);
        }
        ctx.shadowBlur = 0;
      }

      // Telephone poles + sagging wires
      ctx.strokeStyle = "#1d1016";
      ctx.fillStyle = "#1d1016";
      for (const px of [70, CANVAS_W - 90]) {
        ctx.fillRect(px, GROUND_SCREEN_Y - 250, 7, 210);
        ctx.fillRect(px - 18, GROUND_SCREEN_Y - 240, 43, 5);
      }
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(73, GROUND_SCREEN_Y - 236);
      ctx.quadraticCurveTo(CANVAS_W / 2, GROUND_SCREEN_Y - 190, CANVAS_W - 87, GROUND_SCREEN_Y - 236);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(73, GROUND_SCREEN_Y - 226);
      ctx.quadraticCurveTo(CANVAS_W / 2, GROUND_SCREEN_Y - 176, CANVAS_W - 87, GROUND_SCREEN_Y - 226);
      ctx.stroke();

      // Lit storefront strip behind the crowd
      const stripTop = GROUND_SCREEN_Y - 46;
      const strip = ctx.createLinearGradient(0, stripTop, 0, GROUND_SCREEN_Y);
      strip.addColorStop(0, "rgba(255,190,110,0.5)");
      strip.addColorStop(1, "rgba(255,190,110,0.08)");
      ctx.fillStyle = strip;
      ctx.fillRect(0, stripTop, CANVAS_W, 46);

      // Backlit crowd (two loose rows) — they bounce harder when hyped, and
      // a few of them jump outright on big moments.
      const crowdY = GROUND_SCREEN_Y - 26;
      const hype = crowdHype > 0 ? Math.min(1, crowdHype / 60) : 0;
      for (let i = 0; i < 30; i++) {
        const cx = (i / 29) * (CANVAS_W - 16) + 8;
        const back = i % 2 === 0;
        const bob = Math.sin(animTimer * (0.06 + hype * 0.14) + i * 1.7) * (2 + hype * 3);
        const jump = hype > 0 && i % 3 === 0 ? Math.max(0, Math.sin(animTimer * 0.25 + i * 2.1)) * 8 * hype : 0;
        const yOff = (back ? -7 : 2) - jump;
        ctx.fillStyle = back ? "#241018" : "#170a10";
        ctx.fillRect(cx - 7, crowdY + 7 + bob + yOff, 14, 20);
        ctx.beginPath();
        ctx.arc(cx, crowdY + bob + yOff, 7, 0, Math.PI * 2);
        ctx.fill();
      }

      // crowd chatter bubbles float up over the heads
      for (const b of bubbles) {
        const t = b.life / b.maxLife;
        const bx = b.x;
        const by = crowdY - 26 - t * 14;
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
      ctx.textAlign = "left";

      // Asphalt with sunset reflection
      const road = ctx.createLinearGradient(0, GROUND_SCREEN_Y, 0, CANVAS_H);
      road.addColorStop(0, "#5b3242");
      road.addColorStop(0.35, "#3c2231");
      road.addColorStop(1, "#241521");
      ctx.fillStyle = road;
      ctx.fillRect(0, GROUND_SCREEN_Y, CANVAS_W, CANVAS_H - GROUND_SCREEN_Y);

      // warm light pooling under the fighters
      const pool = ctx.createRadialGradient(CANVAS_W / 2, GROUND_SCREEN_Y + 8, 20, CANVAS_W / 2, GROUND_SCREEN_Y + 8, 320);
      pool.addColorStop(0, "rgba(255,170,90,0.28)");
      pool.addColorStop(1, "rgba(255,170,90,0)");
      ctx.fillStyle = pool;
      ctx.fillRect(0, GROUND_SCREEN_Y, CANVAS_W, CANVAS_H - GROUND_SCREEN_Y);

      // pavement seams receding toward a vanishing point
      ctx.strokeStyle = "rgba(255,220,180,0.10)";
      ctx.lineWidth = 1;
      const vpX = CANVAS_W / 2;
      for (let i = -5; i <= 5; i++) {
        ctx.beginPath();
        ctx.moveTo(vpX + i * 40, GROUND_SCREEN_Y);
        ctx.lineTo(vpX + i * 170, CANVAS_H);
        ctx.stroke();
      }
      for (const ly of [GROUND_SCREEN_Y + 18, GROUND_SCREEN_Y + 44] ) {
        ctx.beginPath();
        ctx.moveTo(0, ly);
        ctx.lineTo(CANVAS_W, ly);
        ctx.stroke();
      }

      // curb line
      ctx.strokeStyle = "rgba(255,200,140,0.45)";
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

      // camera: ease toward the midpoint of the fighters, zooming with proximity
      const pX = world.player.x * SCALE;
      const oX = world.opponent.x * SCALE;
      const proximity = Math.max(0, Math.min(1, 1 - Math.abs(pX - oX) / (CANVAS_W * 0.65)));
      const koBoost = koZoomFrames > 0 ? (koZoomFrames / 45) * 0.2 : 0;
      const targetZ = Math.min(1.35, 1.02 + proximity * 0.14 + koBoost);
      camZ += (targetZ - camZ) * 0.08;
      const halfW = CANVAS_W / (2 * camZ);
      const targetX = Math.max(halfW, Math.min(CANVAS_W - halfW, (pX + oX) / 2));
      camX += (targetX - camX) * 0.1;
      camX = Math.max(halfW, Math.min(CANVAS_W - halfW, camX));
      const camY = CANVAS_H - CANVAS_H / (2 * camZ); // hug the ground so the road stays in frame
      ctx.translate(CANVAS_W / 2, CANVAS_H / 2);
      ctx.scale(camZ, camZ);
      ctx.translate(-camX, -camY);

      drawBackground();

      // super cinematic: dim the street, spotlight whoever is unleashing it
      const superFighter = superInFlight();
      if (superFighter) {
        ctx.fillStyle = "rgba(8,4,22,0.6)";
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
      drawTrails();
      drawFighter(world.opponent, true);
      drawFighter(world.player, false);
      drawFlashes();
      drawParticles();
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
      slowmoFrames = 0;
      koPendingFrames = -1;
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
      bubbles = bubbles.filter((b) => {
        b.life += 1;
        return b.life < b.maxLife;
      });
      // ghost HP holds for a beat, then drains toward the real value
      for (const side of ["player", "opponent"] as const) {
        if (ghostDelay[side] > 0) ghostDelay[side] -= 1;
        else ghostHp[side] = Math.max(world[side].hp, ghostHp[side] - 1.1);
      }

      if (phase === "intro") {
        if (phaseTimer === 90) sfx.roundStart();
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
          if (playerRounds > opponentRounds) sfx.win();
          else sfx.lose();
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

      // slow motion after the freeze: world steps at 1/3 speed
      if (slowmoFrames > 0) {
        slowmoFrames -= 1;
        if (animTimer % 3 !== 0) return;
      }

      timeLeftFrames = Math.max(0, timeLeftFrames - 1);
      const playerInput = inputFromKeys();
      const opponentInput = tickAi(aiBrain, world.frame, world.opponent, world.player, opponent);
      const result = stepFight(world, playerInput, opponentInput);
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
            slowmoFrames = 14; // the final blow of a super lands in slow motion
            koZoomFrames = Math.max(koZoomFrames, 24);
            crowdHype = Math.max(crowdHype, 90);
            crowdShout(true);
          } else if (heavy) {
            screenFlash = 5;
            crowdHype = Math.max(crowdHype, 40);
          }
          sfx.hit(heavy || isSuper);
          if (isSuper) sfx.ko();
          if (ev.attacker === "player") {
            if (ev.defenderWasAirborne) landedAntiAir = true;
            const combo = ev.comboCount ?? 0;
            if (combo >= 3) landedCombo = true;
            if (combo >= 2) {
              comboShown = combo;
              comboTimer = 55;
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
          sfx.block();
        }

        if (ev.type === "ko") {
          sfx.ko();
          hitstopFrames = 18; // long freeze sells the finishing blow
          shakeFrames = 16;
          shakeMag = 9;
          screenFlash = SCREEN_FLASH_MAX;
          koZoomFrames = 45;
          crowdHype = 120;
          crowdShout(true);
          spawnImpactFlash(point.x, point.y, 100, "#ffffff", true);
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
        // On a knockout the loser falls in slow motion before the banner drops.
        if ((playerDown || opponentDown) && koPendingFrames === -1 && !timeUp) {
          koPendingFrames = 40;
          slowmoFrames = Math.max(slowmoFrames, 40);
        }
        if (koPendingFrames > 0) {
          koPendingFrames -= 1;
          return;
        }
        koPendingFrames = -1;
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
  }, [opponent]);

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
