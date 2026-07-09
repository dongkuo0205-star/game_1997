import { AttackId, Fighter, FightInput, NEUTRAL_INPUT } from "./types";
import { ATTACKS } from "./constants";
import { Opponent } from "@/types/game";

export interface AiBrain {
  nextDecisionAt: number;
  input: FightInput;
}

export function createAiBrain(): AiBrain {
  return { nextDecisionAt: 0, input: { ...NEUTRAL_INPUT } };
}

function pick<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function reactionDelayFrames(reaction: number): number {
  const r = Math.max(0, Math.min(100, reaction)) / 100;
  return Math.round(26 - r * 18); // 26 frames (slow) .. 8 frames (sharp)
}

function decide(self: Fighter, foe: Fighter, opponent: Opponent): FightInput {
  const input: FightInput = { ...NEUTRAL_INPUT };
  if (self.action === "ko" || foe.action === "ko") return input;

  const skill = Math.max(0, Math.min(100, opponent.skill)) / 100;
  const reaction = Math.max(0, Math.min(100, opponent.reaction)) / 100;
  const mind = Math.max(0, Math.min(100, opponent.mind)) / 100;

  const dx = foe.x - self.x;
  const absDist = Math.abs(dx);
  const towardFoe = dx > 0 ? "right" : "left";
  const awayFromFoe = dx > 0 ? "left" : "right";

  // Read the opponent's active/startup attack and sometimes block it.
  if (foe.action === "attack" && foe.attackId) {
    const def = ATTACKS[foe.attackId];
    const framesToImpact = def.startup - foe.actionFrame;
    if (framesToImpact >= 0 && framesToImpact <= 6 && absDist < def.reachX + 10) {
      if (Math.random() < reaction * 0.8) {
        input[awayFromFoe as "left" | "right"] = true;
        return input;
      }
    }
  }

  const attackRange = 24;
  if (absDist <= attackRange) {
    // Meter full: smart opponents cash it in for a super.
    if (self.meter >= 100 && Math.random() < 0.3 + mind * 0.5) {
      input.super = true;
      return input;
    }
    // In range: mostly attack, occasionally retreat if low on HP and cautious.
    const wantsToRetreat = self.hp < 25 && Math.random() < mind * 0.35;
    if (wantsToRetreat) {
      input[awayFromFoe as "left" | "right"] = true;
      return input;
    }
    const pool: AttackId[] = skill > 0.6 ? ["lp", "lp", "hp", "lk", "hk"] : ["lp", "lp", "lk"];
    const attack = pick(pool);
    input[attack] = true;
    return input;
  }

  // Out of range: close the distance, with occasional jump-ins for aggressive opponents.
  if (Math.random() < skill * 0.08) {
    input.up = true;
  }
  input[towardFoe as "left" | "right"] = true;
  return input;
}

export function tickAi(brain: AiBrain, frame: number, self: Fighter, foe: Fighter, opponent: Opponent): FightInput {
  if (frame >= brain.nextDecisionAt) {
    brain.input = decide(self, foe, opponent);
    brain.nextDecisionAt = frame + reactionDelayFrames(opponent.reaction);
  }
  return brain.input;
}
