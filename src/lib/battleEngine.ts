import { ACTIONS, getAction } from "@/data/actions";
import { pickOpponentAction } from "@/lib/opponentAI";
import {
  ActionId,
  BattleState,
  Distance,
  Momentum,
  Opponent,
  PlayerStats,
  StatChanges,
} from "@/types/game";

const MAX_EXCHANGES_PER_ROUND = 8;
const ROUNDS_TO_WIN = 2;

export function createBattleState(opponent: Opponent): BattleState {
  return {
    opponent,
    playerHp: 100,
    opponentHp: 100,
    playerMeter: 0,
    opponentMeter: 0,
    roundNumber: 1,
    playerRoundsWon: 0,
    opponentRoundsWon: 0,
    distance: "mid",
    momentum: "neutral",
    exchangeCount: 0,
    matchOver: false,
  };
}

function playerPower(stats: PlayerStats): number {
  return stats.skill * 0.5 + stats.reaction * 0.3 + stats.combo * 0.2;
}

function opponentPower(opponent: Opponent): number {
  return opponent.skill * 0.5 + opponent.reaction * 0.3 + opponent.mind * 0.2;
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function jitter(): number {
  return 0.85 + Math.random() * 0.3;
}

export type ExchangeAdvantage = "player" | "opponent" | "neutral";

export type ExchangeOutcomeKind =
  | "player_hit" // 玩家命中
  | "opponent_hit" // 对手命中
  | "trade_hit" // 双方互相打中
  | "stalemate" // 双方对峙，无伤害
  | "player_blocked" // 玩家的攻击被挡下/落空
  | "opponent_blocked" // 对手的攻击被挡下/落空
  | "player_reversed" // 玩家判断错误，被反将一军
  | "opponent_reversed"; // 对手判断错误，被玩家反将一军

export interface ExchangeResult {
  opponentActionId: ActionId;
  advantage: ExchangeAdvantage;
  outcomeKind: ExchangeOutcomeKind;
  damageToPlayer: number;
  damageToOpponent: number;
  playerMeterGain: number;
  opponentMeterGain: number;
  playerLandedAntiAir: boolean;
  playerLandedCombo: boolean;
}

export function resolveExchange(
  stats: PlayerStats,
  battle: BattleState,
  playerActionId: ActionId
): ExchangeResult {
  const opponent = battle.opponent;
  const opponentActionId = pickOpponentAction(opponent, battle);

  const playerDef = getAction(playerActionId);
  const oppDef = getAction(opponentActionId);

  const pPower = playerPower(stats);
  const oPower = opponentPower(opponent);

  const playerBeatsOpp = playerDef.beats.includes(opponentActionId);
  const oppBeatsPlayer = oppDef.beats.includes(playerActionId);

  let advantage: ExchangeAdvantage = "neutral";
  if (playerBeatsOpp && !oppBeatsPlayer) advantage = "player";
  else if (oppBeatsPlayer && !playerBeatsOpp) advantage = "opponent";

  let damageToPlayer = 0;
  let damageToOpponent = 0;
  let outcomeKind: ExchangeOutcomeKind = "stalemate";

  if (advantage === "player") {
    const successChance = clamp(
      0.6 + (pPower - oPower) / 150 - playerDef.risk * 0.1,
      0.2,
      0.92
    );
    if (Math.random() < successChance) {
      damageToOpponent = Math.max(1, Math.round(playerDef.baseDamage * (1 + (pPower - oPower) / 120) * jitter()));
      outcomeKind = "player_hit";
    } else {
      damageToPlayer = Math.max(6, Math.round(10 + (oPower - pPower) / 10));
      outcomeKind = "player_reversed";
    }
  } else if (advantage === "opponent") {
    const successChance = clamp(
      0.6 + (oPower - pPower) / 150 - oppDef.risk * 0.1,
      0.2,
      0.92
    );
    if (Math.random() < successChance) {
      damageToPlayer = Math.max(1, Math.round(oppDef.baseDamage * (1 + (oPower - pPower) / 120) * jitter()));
      outcomeKind = "opponent_hit";
    } else {
      damageToOpponent = Math.max(6, Math.round(10 + (pPower - oPower) / 10));
      outcomeKind = "opponent_reversed";
    }
  } else {
    // Neutral matchup: category shape decides what "no clear counter" looks like.
    const playerIsAggressive = playerDef.category === "attack" || playerDef.category === "highrisk";
    const oppIsAggressive = oppDef.category === "attack" || oppDef.category === "highrisk";

    if (playerIsAggressive && oppIsAggressive) {
      damageToOpponent = Math.max(1, Math.round(playerDef.baseDamage * 0.55 * jitter()));
      damageToPlayer = Math.max(1, Math.round(oppDef.baseDamage * 0.55 * jitter()));
      outcomeKind = "trade_hit";
    } else if (playerIsAggressive && !oppIsAggressive) {
      damageToOpponent = Math.max(1, Math.round(playerDef.baseDamage * 0.35 * jitter()));
      outcomeKind = "opponent_blocked";
    } else if (!playerIsAggressive && oppIsAggressive) {
      damageToPlayer = Math.max(1, Math.round(oppDef.baseDamage * 0.35 * jitter()));
      outcomeKind = "player_blocked";
    } else {
      outcomeKind = "stalemate";
    }
  }

  return {
    opponentActionId,
    advantage,
    outcomeKind,
    damageToPlayer,
    damageToOpponent,
    playerMeterGain: playerDef.meterGain,
    opponentMeterGain: oppDef.meterGain,
    playerLandedAntiAir: playerActionId === "anti_air" && outcomeKind === "player_hit",
    playerLandedCombo: playerActionId === "combo_attempt" && outcomeKind === "player_hit",
  };
}

function nextDistance(current: Distance, playerActionId: ActionId, opponentActionId: ActionId): Distance {
  const closers: ActionId[] = ["heavy_pressure", "grapple", "special_rush", "combo_attempt"];
  const openers: ActionId[] = ["back_step", "bait_jump"];
  if (closers.includes(playerActionId) || closers.includes(opponentActionId)) return "close";
  if (openers.includes(playerActionId) && openers.includes(opponentActionId)) return "far";
  if (current === "close") return "mid";
  if (current === "far") return "mid";
  return current;
}

function nextMomentum(result: ExchangeResult): Momentum {
  if (result.outcomeKind === "player_hit" || result.outcomeKind === "opponent_reversed") return "player";
  if (result.outcomeKind === "opponent_hit" || result.outcomeKind === "player_reversed") return "opponent";
  return "neutral";
}

export interface ApplyResult {
  battle: BattleState;
  roundOver: boolean;
  matchOver: boolean;
  playerWonRound?: boolean;
  playerWonMatch?: boolean;
}

export function applyExchange(
  battle: BattleState,
  result: ExchangeResult,
  playerActionId: ActionId
): ApplyResult {
  const playerHp = clamp(battle.playerHp - result.damageToPlayer, 0, 100);
  const opponentHp = clamp(battle.opponentHp - result.damageToOpponent, 0, 100);
  const playerMeter = clamp(battle.playerMeter + result.playerMeterGain, 0, 100);
  const opponentMeter = clamp(battle.opponentMeter + result.opponentMeterGain, 0, 100);
  const exchangeCount = battle.exchangeCount + 1;
  const distance = nextDistance(battle.distance, playerActionId, result.opponentActionId);
  const momentum = nextMomentum(result);

  const hpExhausted = playerHp <= 0 || opponentHp <= 0;
  const exchangeCapped = exchangeCount >= MAX_EXCHANGES_PER_ROUND;
  const roundOver = hpExhausted || exchangeCapped;

  let next: BattleState = {
    ...battle,
    playerHp,
    opponentHp,
    playerMeter,
    opponentMeter,
    exchangeCount,
    distance,
    momentum,
  };

  if (!roundOver) {
    return { battle: next, roundOver: false, matchOver: false };
  }

  const playerWonRound = playerHp > opponentHp;
  const playerRoundsWon = battle.playerRoundsWon + (playerWonRound ? 1 : 0);
  const opponentRoundsWon = battle.opponentRoundsWon + (playerWonRound ? 0 : 1);
  const matchOver =
    playerRoundsWon >= ROUNDS_TO_WIN || opponentRoundsWon >= ROUNDS_TO_WIN;

  next = {
    ...next,
    playerRoundsWon,
    opponentRoundsWon,
    matchOver,
    playerWonMatch: matchOver ? playerRoundsWon > opponentRoundsWon : undefined,
  };

  if (!matchOver) {
    // Reset for next round, keep the score.
    next = {
      ...next,
      playerHp: 100,
      opponentHp: 100,
      playerMeter: 0,
      opponentMeter: 0,
      distance: "mid",
      momentum: "neutral",
      exchangeCount: 0,
      roundNumber: (next.roundNumber + 1) as 1 | 2 | 3,
    };
  }

  return {
    battle: next,
    roundOver: true,
    matchOver,
    playerWonRound,
    playerWonMatch: matchOver ? playerRoundsWon > opponentRoundsWon : undefined,
  };
}

/** Contextual candidate action pool offered to the player this exchange. */
export function pickCandidateActions(battle: BattleState): ActionId[] {
  const { distance, playerMeter, playerHp, opponentHp } = battle;
  const pools: Record<Distance, ActionId[]> = {
    far: ["jump_attack", "special_rush", "observe", "bait_jump", "wait_counter"],
    mid: ["low_poke", "heavy_pressure", "feint", "taunt", "pause_bait", "back_step", "anti_air"],
    close: ["heavy_pressure", "grapple", "combo_attempt", "crouch_block", "wait_counter"],
  };
  const pool = [...pools[distance]];

  if (playerMeter >= 40) pool.push("rage_counter");
  if (playerMeter >= 50) pool.push("reversal_combo");
  if (playerMeter >= 60) pool.push("super_move");
  if (playerHp < 30) pool.push("rage_counter");
  if (opponentHp < 25) pool.push("combo_attempt");

  const unique = [...new Set(pool)].filter((id) => {
    const def = ACTIONS[id];
    return def.meterCost === 0 || playerMeter >= def.meterCost;
  });

  // Shuffle and take 3.
  for (let i = unique.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [unique[i], unique[j]] = [unique[j], unique[i]];
  }
  return unique.slice(0, 3);
}

/**
 * Stat deltas applied once a match concludes. win_streak/total_wins/total_losses
 * are plain counters handled client-side in gameState.ts, not part of this payload.
 */
export function computeMatchGrowth(
  won: boolean,
  comeback: boolean,
  landedAntiAir: boolean,
  landedCombo: boolean
): StatChanges {
  const statChanges: StatChanges = {};
  if (landedAntiAir) statChanges.reaction = (statChanges.reaction ?? 0) + 1;
  if (landedCombo) statChanges.combo = (statChanges.combo ?? 0) + 1;
  if (won) {
    statChanges.fame = (statChanges.fame ?? 0) + 2 + Math.floor(Math.random() * 3);
    statChanges.money = (statChanges.money ?? 0) + 300;
    if (comeback) statChanges.mind = (statChanges.mind ?? 0) + 2;
  } else {
    statChanges.skill = (statChanges.skill ?? 0) + 1;
    statChanges.mind = (statChanges.mind ?? 0) + 1;
  }
  return statChanges;
}
