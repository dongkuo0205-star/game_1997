import { NextRequest, NextResponse } from "next/server";
import { getAction } from "@/data/actions";
import {
  applyExchange,
  computeMatchGrowth,
  pickCandidateActions,
  resolveExchange,
} from "@/lib/battleEngine";
import { narrateExchange } from "@/lib/claude";
import { NarratorContext } from "@/lib/prompts";
import { BattleTurnRequest, BattleTurnResultPayload } from "@/types/game";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as BattleTurnRequest;
  const { stats, battle, chosenActionId } = body;

  const exchangeResult = resolveExchange(stats, battle, chosenActionId);
  const applyResult = applyExchange(battle, exchangeResult, chosenActionId);

  const wasBehind = battle.playerHp < battle.opponentHp;
  const comeback = Boolean(applyResult.playerWonRound) && wasBehind;

  const statChanges = applyResult.matchOver
    ? computeMatchGrowth(
        Boolean(applyResult.playerWonMatch),
        comeback,
        exchangeResult.playerLandedAntiAir,
        exchangeResult.playerLandedCombo
      )
    : {};

  const candidateActionIds = applyResult.matchOver
    ? []
    : pickCandidateActions(applyResult.battle);

  const ctx: NarratorContext = {
    day: stats.day,
    opponent: battle.opponent,
    stats,
    battle: applyResult.battle,
    mechanicalResult: {
      playerActionKo: getAction(chosenActionId).labelKo,
      opponentActionKo: getAction(exchangeResult.opponentActionId).labelKo,
      resultKind: exchangeResult.outcomeKind,
      damageToPlayer: exchangeResult.damageToPlayer,
      damageToOpponent: exchangeResult.damageToOpponent,
      roundOver: applyResult.roundOver,
      matchOver: applyResult.matchOver,
      playerWonRound: applyResult.playerWonRound,
      playerWonMatch: applyResult.playerWonMatch,
    },
    candidateActionIds,
  };

  const { story, choices } = await narrateExchange(ctx);

  const payload: BattleTurnResultPayload = {
    story,
    battle: {
      round: applyResult.battle.roundNumber,
      player_hp: applyResult.battle.playerHp,
      opponent_hp: applyResult.battle.opponentHp,
      distance: applyResult.battle.distance,
      momentum: applyResult.battle.momentum,
      result: exchangeResult.outcomeKind,
    },
    battle_state: applyResult.battle,
    stat_changes: statChanges,
    choices,
    flags: [],
    match_over: applyResult.matchOver,
    player_won_match: applyResult.playerWonMatch,
  };

  return NextResponse.json(payload);
}
