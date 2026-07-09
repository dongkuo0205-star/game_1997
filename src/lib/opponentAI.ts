import { ACTIONS } from "@/data/actions";
import { ActionId, BattleState, Opponent } from "@/types/game";

function weightedPick(weights: Map<ActionId, number>): ActionId {
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  let roll = Math.random() * total;
  for (const [id, w] of weights) {
    roll -= w;
    if (roll <= 0) return id;
  }
  return [...weights.keys()][0];
}

/**
 * Picks the opponent's action for this exchange. Weighted toward their
 * favoriteTactic and away from their known weakness, with the spread
 * narrowing as difficulty rises (higher difficulty = more consistent play).
 */
export function pickOpponentAction(opponent: Opponent, battle: BattleState): ActionId {
  const weights = new Map<ActionId, number>();
  const allIds = Object.keys(ACTIONS) as ActionId[];

  for (const id of allIds) {
    const def = ACTIONS[id];
    if (def.meterCost > 0 && battle.opponentMeter < def.meterCost) continue;
    let w = 1;
    if (id === opponent.favoriteTactic) w += 2 + opponent.difficulty;
    if (id === opponent.weakness) w = Math.max(0.2, w - 1.5);
    if (battle.momentum === "opponent" && def.category === "attack") w += 1;
    if (battle.momentum === "player" && def.category === "defense") w += 1;
    if (battle.opponentHp < 30 && def.category === "highrisk") w += opponent.difficulty;
    weights.set(id, w);
  }
  return weightedPick(weights);
}
