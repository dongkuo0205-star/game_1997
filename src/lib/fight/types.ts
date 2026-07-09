// ============================================================================
// Real-time fight engine types. Pure data — no DOM/canvas references here so
// the engine can be unit-tested headlessly (see scripts/fight-engine-test).
// ============================================================================

export type FighterId = "player" | "opponent";

export type AttackId = "lp" | "hp" | "lk" | "hk" | "super";

export type FighterAction =
  | "idle"
  | "walk"
  | "jump"
  | "crouch"
  | "attack"
  | "hitstun"
  | "block"
  | "ko";

export interface FightInput {
  left: boolean;
  right: boolean;
  up: boolean;
  down: boolean;
  lp: boolean;
  hp: boolean;
  lk: boolean;
  hk: boolean;
  super: boolean;
}

export const NEUTRAL_INPUT: FightInput = {
  left: false,
  right: false,
  up: false,
  down: false,
  lp: false,
  hp: false,
  lk: false,
  hk: false,
  super: false,
};

export interface AttackDef {
  id: AttackId;
  startup: number; // frames before hitbox becomes active
  active: number; // frames the hitbox can land
  recovery: number; // frames after active before fighter can act again
  damage: number;
  chipDamage: number; // damage dealt on block
  reachX: number; // horizontal hitbox reach from fighter center, in stage units
  reachY: number; // vertical half-height of hitbox
  hitstun: number; // frames the defender is stunned on clean hit
  blockstun: number; // frames the defender is stunned on block
  pushback: number; // horizontal knockback applied to defender on clean hit
  meterGain: number;
  isLow: boolean; // must be blocked crouching
}

export interface Fighter {
  id: FighterId;
  x: number;
  y: number; // 0 = grounded; positive = height above ground
  vx: number;
  vy: number;
  facing: 1 | -1;
  action: FighterAction;
  hp: number;
  meter: number;
  attackId: AttackId | null;
  actionFrame: number; // frames elapsed since entering current action
  stunFrames: number; // remaining hitstun/blockstun frames
  hasHitThisAttack: boolean;
  comboCount: number; // consecutive hits landed on the opponent without a whiff/reset
  framesSinceLastLand: number; // frames since this fighter last landed a hit (for combo window)
}

export interface FightEvent {
  type: "hit" | "block" | "ko";
  attacker: FighterId;
  defender: FighterId;
  attackId?: AttackId;
  comboCount?: number;
  defenderWasAirborne?: boolean;
}

export interface FightWorld {
  frame: number;
  player: Fighter;
  opponent: Fighter;
}
