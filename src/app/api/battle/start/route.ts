import { NextRequest, NextResponse } from "next/server";
import { generateOpponent } from "@/data/opponents";
import { createBattleState, pickCandidateActions } from "@/lib/battleEngine";
import { narrateMatchStart } from "@/lib/claude";
import { MATCH_COST } from "@/lib/gameState";
import { NarratorContext } from "@/lib/prompts";
import { PlayerStats, StartMatchResponsePayload } from "@/types/game";

export async function POST(req: NextRequest) {
  const body = (await req.json()) as { stats: PlayerStats };
  const { stats } = body;

  if (stats.money < MATCH_COST) {
    return NextResponse.json(
      { error: "돈이 부족합니다. 오늘은 더 이상 도전할 수 없습니다." },
      { status: 400 }
    );
  }

  const opponent = generateOpponent(stats);
  const battle = createBattleState(opponent);
  const candidateActionIds = pickCandidateActions(battle);

  const ctx: NarratorContext = {
    day: stats.day,
    opponent,
    stats,
    battle,
    mechanicalResult: null,
    candidateActionIds,
  };

  const { story, choices } = await narrateMatchStart(ctx);

  const payload: StartMatchResponsePayload = {
    story,
    opponent,
    battle: {
      round: battle.roundNumber,
      player_hp: battle.playerHp,
      opponent_hp: battle.opponentHp,
      distance: battle.distance,
      momentum: battle.momentum,
      result: "match_start",
    },
    battle_state: battle,
    choices,
    matchCost: MATCH_COST,
  };

  return NextResponse.json(payload);
}
