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

    function drawFighter(f: Fighter, isOpponent: boolean) {
      if (!sheets) return;
      const { anim, frame, squashY } = resolveAnim(f);
      const img = sheets.images[anim];
      const { centerX, bottomY, height } = sheets.anchor;
      const s = FIGURE_HEIGHT / height;

      const feetX = f.x * SCALE;
      const feetY = GROUND_SCREEN_Y - f.y * SCALE;

      // super aura behind the fighter while the super attack is live
      if (f.action === "attack" && f.attackId === "super") {
        const pulse = 0.75 + Math.sin(animTimer * 0.9) * 0.25;
        const aura = ctx.createRadialGradient(feetX, feetY - FIGURE_HEIGHT * 0.5, 10, feetX, feetY - FIGURE_HEIGHT * 0.5, 110);
        aura.addColorStop(0, `rgba(255,220,90,${0.5 * pulse})`);
        aura.addColorStop(1, "rgba(255,220,90,0)");
        ctx.fillStyle = aura;
        ctx.fillRect(feetX - 120, feetY - FIGURE_HEIGHT - 40, 240, FIGURE_HEIGHT + 60);
      }

      ctx.save();
      ctx.translate(feetX, feetY);
      ctx.scale(f.facing, squashY);
      ctx.imageSmoothingEnabled = false;
      let filter = filterFor(f, isOpponent);
      if (f.action === "attack" && f.attackId === "super") {
        filter = filter === "none" ? "brightness(1.4) saturate(1.5)" : `${filter} brightness(1.4) saturate(1.5)`;
      }
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

    function drawHpBar(x: number, hp: number, alignRight: boolean) {
      const w = 280;
      const h = 18;
      const pct = Math.max(0, Math.min(1, hp / MAX_HP));
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.fillRect(x, 14, w, h);
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
      drawHpBar(16, world.player.hp, false);
      drawHpBar(CANVAS_W - 16 - 280, world.opponent.hp, true);
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

      // combo counter
      if (comboTimer > 0 && comboShown >= 2) {
        const pop = comboTimer > 45 ? 1.35 : 1;
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
        ctx.font = "bold 32px monospace";
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

      // Backlit crowd (two loose rows)
      const crowdY = GROUND_SCREEN_Y - 26;
      for (let i = 0; i < 30; i++) {
        const cx = (i / 29) * (CANVAS_W - 16) + 8;
        const back = i % 2 === 0;
        const bob = Math.sin(animTimer * 0.06 + i * 1.7) * 2;
        const yOff = back ? -7 : 2;
        ctx.fillStyle = back ? "#241018" : "#170a10";
        ctx.fillRect(cx - 7, crowdY + 7 + bob + yOff, 14, 20);
        ctx.beginPath();
        ctx.arc(cx, crowdY + bob + yOff, 7, 0, Math.PI * 2);
        ctx.fill();
      }

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

    function draw() {
      ctx.save();
      if (shakeFrames > 0) {
        const decay = shakeFrames / 10;
        ctx.translate(
          (Math.random() * 2 - 1) * shakeMag * decay,
          (Math.random() * 2 - 1) * shakeMag * decay
        );
      }
      drawBackground();
      // simple ground shadows
      for (const f of [world.player, world.opponent]) {
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.beginPath();
        ctx.ellipse(f.x * SCALE, GROUND_SCREEN_Y + 6, 34, 8, 0, 0, Math.PI * 2);
        ctx.fill();
      }
      drawFighter(world.opponent, true);
      drawFighter(world.player, false);
      drawParticles();
      ctx.restore();
      drawHud();
    }

    function startNextRoundOrEnd() {
      if (playerRounds >= ROUNDS_TO_WIN || opponentRounds >= ROUNDS_TO_WIN) {
        phase = "matchEnd";
        return;
      }
      roundNumber += 1;
      world = createWorld();
      timeLeftFrames = ROUND_TIME_SECONDS * 60;
      phase = "intro";
      phaseTimer = 90;
    }

    function tick() {
      animTimer += 1;
      updateParticles();
      if (comboTimer > 0) comboTimer -= 1;
      if (shakeFrames > 0) shakeFrames -= 1;

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
          hitstopFrames = isSuper ? 12 : heavy ? 7 : 4;
          shakeFrames = isSuper ? 18 : heavy ? 10 : 5;
          shakeMag = isSuper ? 11 : heavy ? 7 : 4;
          sfx.hit(heavy || isSuper);
          if (isSuper) sfx.ko();
          if (ev.attacker === "player") {
            if (ev.defenderWasAirborne) landedAntiAir = true;
            const combo = ev.comboCount ?? 0;
            if (combo >= 3) landedCombo = true;
            if (combo >= 2) {
              comboShown = combo;
              comboTimer = 55;
            }
          }
        } else if (ev.type === "block") {
          spawnSparks(point.x, point.y, ["#7fd8ff", "#cfeeff"], 6, 2.5);
          hitstopFrames = 2;
          sfx.block();
        }

        if (ev.type === "ko") {
          sfx.ko();
          shakeFrames = 16;
          shakeMag = 9;
        }
      }

      const playerDown = world.player.action === "ko";
      const opponentDown = world.opponent.action === "ko";
      const timeUp = timeLeftFrames <= 0;
      if (playerDown || opponentDown || timeUp) {
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
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [opponent]);

  const press = (field: keyof FightInput, down: boolean) => {
    touchInputRef.current[field] = down;
    if (down) {
      sfx.unlock();
      startBgm();
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
