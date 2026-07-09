import { AttackDef, AttackId } from "./types";

export const STAGE_WIDTH = 256; // stage units, not pixels
export const STAGE_MARGIN = 14; // how close a fighter can get to the stage edge
export const GROUND_Y = 0;

export const GRAVITY = -0.85;
export const JUMP_VZ = 11.5;
export const WALK_SPEED = 1.6;
export const MIN_SPACING = 16; // fighters can't overlap past this distance

export const ROUND_TIME_SECONDS = 30;
export const SUPER_METER_COST = 100;
export const ROUNDS_TO_WIN = 2;
export const MAX_HP = 100;

// Frame-perfect attack data. "reachX" is measured from the attacker's chest,
// so a light punch's real max range is roughly reachX + MIN_SPACING/2.
export const ATTACKS: Record<AttackId, AttackDef> = {
  lp: {
    id: "lp",
    startup: 4,
    active: 4,
    recovery: 8,
    damage: 4,
    chipDamage: 1,
    reachX: 22,
    reachY: 14,
    hitstun: 12,
    blockstun: 6,
    pushback: 3,
    meterGain: 4,
    isLow: false,
  },
  hp: {
    id: "hp",
    startup: 8,
    active: 5,
    recovery: 16,
    damage: 10,
    chipDamage: 2,
    reachX: 26,
    reachY: 14,
    hitstun: 20,
    blockstun: 10,
    pushback: 7,
    meterGain: 8,
    isLow: false,
  },
  lk: {
    id: "lk",
    startup: 5,
    active: 4,
    recovery: 10,
    damage: 6,
    chipDamage: 1,
    reachX: 24,
    reachY: 10,
    hitstun: 14,
    blockstun: 7,
    pushback: 4,
    meterGain: 5,
    isLow: true,
  },
  hk: {
    id: "hk",
    startup: 10,
    active: 6,
    recovery: 18,
    damage: 12,
    chipDamage: 3,
    reachX: 28,
    reachY: 12,
    hitstun: 22,
    blockstun: 11,
    pushback: 8,
    meterGain: 9,
    isLow: true,
  },
  super: {
    id: "super",
    startup: 7,
    active: 7,
    recovery: 22,
    damage: 26,
    chipDamage: 6,
    reachX: 34,
    reachY: 16,
    hitstun: 30,
    blockstun: 14,
    pushback: 14,
    meterGain: 0,
    isLow: false,
  },
};

export const COMBO_WINDOW_FRAMES = 26;
