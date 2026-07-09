// ============================================================================
// Pure, DOM-free real-time fight simulation. Same stepFighter() logic drives
// both the human player and the AI (ai.ts just produces a FightInput each
// frame). Deterministic given the same inputs, so this is unit-testable
// without a browser — see scripts/fight-engine-test.mjs.
// ============================================================================

import { ATTACKS, COMBO_WINDOW_FRAMES, GRAVITY, JUMP_VZ, MIN_SPACING, STAGE_MARGIN, STAGE_WIDTH, SUPER_METER_COST, WALK_SPEED } from "./constants";
import { AttackId, Fighter, FighterId, FightEvent, FightInput, FightWorld, NEUTRAL_INPUT } from "./types";

export function createFighter(id: FighterId, x: number, facing: 1 | -1): Fighter {
  return {
    id,
    x,
    y: 0,
    vx: 0,
    vy: 0,
    facing,
    action: "idle",
    hp: 100,
    meter: 0,
    attackId: null,
    actionFrame: 0,
    stunFrames: 0,
    hasHitThisAttack: false,
    comboCount: 0,
    framesSinceLastLand: 999,
  };
}

export function createWorld(): FightWorld {
  return {
    frame: 0,
    player: createFighter("player", STAGE_WIDTH * 0.3, 1),
    opponent: createFighter("opponent", STAGE_WIDTH * 0.7, -1),
  };
}

function isActionable(f: Fighter): boolean {
  return f.action === "idle" || f.action === "walk" || f.action === "crouch" || f.action === "jump";
}

function pickAttack(input: FightInput): AttackId | null {
  if (input.lp) return "lp";
  if (input.hp) return "hp";
  if (input.lk) return "lk";
  if (input.hk) return "hk";
  return null;
}

/** Advances one fighter's local state machine (movement/attack start) — no cross-fighter effects yet. */
function tickFighter(f: Fighter, input: FightInput, opponentX: number): Fighter {
  const next: Fighter = { ...f };
  next.framesSinceLastLand = Math.min(9999, f.framesSinceLastLand + 1);
  if (next.comboCount > 0 && next.framesSinceLastLand > COMBO_WINDOW_FRAMES) {
    next.comboCount = 0;
  }

  const grounded = next.y <= 0;

  if (next.action !== "attack" && next.action !== "hitstun" && grounded) {
    next.facing = opponentX >= next.x ? 1 : -1;
  }

  if (next.stunFrames > 0) {
    next.stunFrames -= 1;
    next.vx *= 0.85;
    if (Math.abs(next.vx) < 0.1) next.vx = 0;
    if (next.stunFrames <= 0 && next.action !== "ko") {
      next.action = grounded ? "idle" : "jump";
      next.actionFrame = 0;
    }
  } else if (next.action === "attack" && next.attackId) {
    next.actionFrame += 1;
    const def = ATTACKS[next.attackId];
    const total = def.startup + def.active + def.recovery;
    if (next.actionFrame >= total) {
      next.action = grounded ? "idle" : "jump";
      next.attackId = null;
      next.actionFrame = 0;
      next.hasHitThisAttack = false;
    }
  } else if (next.action === "ko") {
    next.vx = 0;
  } else {
    // idle / walk / crouch / jump: read input.
    const wantsSuper = input.super && next.meter >= SUPER_METER_COST && grounded;
    const attack = wantsSuper ? "super" : pickAttack(input);
    if (attack === "super" || (attack && grounded)) {
      if (attack === "super") next.meter -= SUPER_METER_COST;
      next.action = "attack";
      next.attackId = attack;
      next.actionFrame = 0;
      next.hasHitThisAttack = false;
      next.vx = 0;
    } else if (input.up && grounded) {
      next.action = "jump";
      next.vy = JUMP_VZ;
      next.vx = input.left ? -WALK_SPEED * 0.8 : input.right ? WALK_SPEED * 0.8 : 0;
    } else if (input.down && grounded) {
      next.action = "crouch";
      next.vx = 0;
    } else {
      const moveDir = input.left ? -1 : input.right ? 1 : 0;
      next.vx = moveDir * WALK_SPEED;
      if (grounded) next.action = moveDir !== 0 ? "walk" : "idle";
    }
  }

  return next;
}

function applyPhysics(f: Fighter): Fighter {
  const next = { ...f };
  if (next.y > 0 || next.vy !== 0) {
    next.vy += GRAVITY;
    next.y += next.vy;
    if (next.y <= 0) {
      next.y = 0;
      next.vy = 0;
      if (next.action === "jump") {
        next.action = "idle";
        next.actionFrame = 0;
      }
    }
  }
  next.x += next.vx;
  next.x = Math.max(STAGE_MARGIN, Math.min(STAGE_WIDTH - STAGE_MARGIN, next.x));
  return next;
}

function resolveSpacing(a: Fighter, b: Fighter): [Fighter, Fighter] {
  const dist = b.x - a.x;
  const absDist = Math.abs(dist);
  if (absDist >= MIN_SPACING) return [a, b];
  const overlap = MIN_SPACING - absDist;
  const dir = dist >= 0 ? 1 : -1; // direction from a to b
  const na = { ...a, x: a.x - (overlap / 2) * dir };
  const nb = { ...b, x: b.x + (overlap / 2) * dir };
  return [
    { ...na, x: Math.max(STAGE_MARGIN, Math.min(STAGE_WIDTH - STAGE_MARGIN, na.x)) },
    { ...nb, x: Math.max(STAGE_MARGIN, Math.min(STAGE_WIDTH - STAGE_MARGIN, nb.x)) },
  ];
}

function isHoldingAway(f: Fighter, input: FightInput): boolean {
  return f.facing === 1 ? input.left : input.right;
}

/** Attacker → defender hit check + resolution. Mutates neither input; returns updates. */
function resolveAttack(
  attacker: Fighter,
  defender: Fighter,
  defenderInput: FightInput
): { attacker: Fighter; defender: Fighter; event: FightEvent | null } {
  if (attacker.action !== "attack" || !attacker.attackId || attacker.hasHitThisAttack) {
    return { attacker, defender, event: null };
  }
  const def = ATTACKS[attacker.attackId];
  const phase = attacker.actionFrame - def.startup;
  if (phase < 0 || phase >= def.active) {
    return { attacker, defender, event: null };
  }
  if (defender.action === "ko") {
    return { attacker, defender, event: null };
  }

  const reach = def.reachX;
  const dx = (defender.x - attacker.x) * attacker.facing; // positive = defender in front
  const dy = Math.abs(defender.y - attacker.y);
  const inRange = dx > -6 && dx < reach && dy < 26;
  if (!inRange) {
    return { attacker, defender, event: null };
  }

  const nextAttacker: Fighter = { ...attacker, hasHitThisAttack: true };
  const defenderWasAirborne = defender.y > 0;
  const blocking =
    defender.action !== "hitstun" &&
    defender.action !== "attack" &&
    isHoldingAway(defender, defenderInput);

  let nextDefender: Fighter;
  let event: FightEvent;

  if (blocking) {
    nextDefender = {
      ...defender,
      hp: Math.max(0, defender.hp - def.chipDamage),
      action: "block",
      stunFrames: def.blockstun,
      vx: attacker.facing * (def.pushback * 0.4),
    };
    event = { type: "block", attacker: attacker.id, defender: defender.id, attackId: def.id };
  } else {
    nextAttacker.comboCount = attacker.framesSinceLastLand <= COMBO_WINDOW_FRAMES ? attacker.comboCount + 1 : 1;
    nextAttacker.framesSinceLastLand = 0;
    const hp = Math.max(0, defender.hp - def.damage);
    nextDefender = {
      ...defender,
      hp,
      action: hp <= 0 ? "ko" : "hitstun",
      stunFrames: def.hitstun,
      vx: attacker.facing * def.pushback,
    };
    event = {
      type: hp <= 0 ? "ko" : "hit",
      attacker: attacker.id,
      defender: defender.id,
      attackId: def.id,
      comboCount: nextAttacker.comboCount,
      defenderWasAirborne,
    };
  }

  nextAttacker.meter = Math.min(100, nextAttacker.meter + def.meterGain);

  return { attacker: nextAttacker, defender: nextDefender, event };
}

export function stepFight(
  world: FightWorld,
  playerInput: FightInput = NEUTRAL_INPUT,
  opponentInput: FightInput = NEUTRAL_INPUT
): { world: FightWorld; events: FightEvent[] } {
  let player = tickFighter(world.player, playerInput, world.opponent.x);
  let opponent = tickFighter(world.opponent, opponentInput, world.player.x);

  player = applyPhysics(player);
  opponent = applyPhysics(opponent);

  [player, opponent] = resolveSpacing(player, opponent);

  const events: FightEvent[] = [];

  const r1 = resolveAttack(player, opponent, opponentInput);
  player = r1.attacker;
  opponent = r1.defender;
  if (r1.event) events.push(r1.event);

  const r2 = resolveAttack(opponent, player, playerInput);
  opponent = r2.attacker;
  player = r2.defender;
  if (r2.event) events.push(r2.event);

  return { world: { frame: world.frame + 1, player, opponent }, events };
}

export function resetForNewRound(f: Fighter, x: number, facing: 1 | -1): Fighter {
  return createFighter(f.id, x, facing);
}
