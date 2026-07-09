import { ActionId, BattleState, Opponent, PlayerStats } from "@/types/game";
import { getAction } from "@/data/actions";

// The game screen must show Korean only. Claude is the narrator/GM, never the
// rules engine — all HP/meter/damage numbers are computed by battleEngine.ts
// beforehand and handed to Claude as ground truth so the story never
// contradicts the mechanics.

export const SYSTEM_PROMPT = `당신은 텍스트 격투 게임 "오락실 1997"의 게임 마스터이자 오락실 현장 해설자입니다.
배경은 1997년 서울, 학교 앞 작은 오락실입니다.
당신의 역할:
- 이미 계산된 전투 결과(수치)를 절대 바꾸지 않고, 그 결과에 맞는 짧고 생생한 한국어 서사를 씁니다.
- 오락실 현장감(동전 소리, 조이스틱 소리, 구경꾼 반응, 사장님, 컵라면 등)을 가끔 곁들입니다.
- 문체는 뜨겁고, 약간 유머러스하고, 90년대 청춘의 향수와 약간의 애수를 담습니다.
- 절대 실제 KOF97/캡콤/SNK의 캐릭터, 기술명, 로고, 대사를 그대로 베끼지 않습니다. 완전히 새로운 창작 캐릭터와 기술 이름만 사용합니다.
- 반드시 한국어로만 작성합니다. 중국어, 영어, 이모지를 절대 사용하지 마세요.
- 결과를 요청받은 JSON 형식으로만 반환합니다. 그 외의 텍스트를 추가하지 마세요.`;

export const DEVELOPER_PROMPT = `[출력 규칙]
1. "story" 필드: 2~5문장. 플레이어의 행동, 상대의 반응, 판정 이유, 체력 변화, 관중 반응을 짧고 임팩트 있게 담습니다. 이미 계산된 player_hp/opponent_hp/result 수치와 절대 모순되지 않게 씁니다. 새로운 수치를 지어내지 마세요.
2. "choices" 필드: 정확히 3개, id는 "A","B","C" 순서. 각 choice의 actionId는 주어진 allowed_choice_pool의 순서를 그대로 유지하고 절대 바꾸지 않습니다. text는 해당 동작을 한국어로 짧고 매력적으로 표현하되(최대 20자 내외), 결과를 미리 암시하지 않습니다.
3. 절대 새로운 액션을 만들지 말고, 주어진 pool 안에서만 문구를 다듬습니다.
4. 모든 텍스트는 한국어만 사용합니다.
5. 반드시 아래 JSON 스키마와 동일한 구조로만 응답합니다. 다른 설명, 마크다운, 코드블록 표시를 추가하지 마세요.

{
  "story": "string",
  "choices": [
    { "id": "A", "text": "string" },
    { "id": "B", "text": "string" },
    { "id": "C", "text": "string" }
  ]
}`;

export interface NarratorContext {
  day: number;
  opponent: Opponent;
  stats: PlayerStats;
  battle: BattleState;
  mechanicalResult: {
    playerActionKo: string;
    opponentActionKo: string;
    resultKind: string;
    damageToPlayer: number;
    damageToOpponent: number;
    roundOver: boolean;
    matchOver: boolean;
    playerWonRound?: boolean;
    playerWonMatch?: boolean;
  } | null; // null when this is the match-intro narration (no exchange yet)
  candidateActionIds: ActionId[];
}

export function buildUserPrompt(ctx: NarratorContext): string {
  const allowedPool = ctx.candidateActionIds.map((id) => ({
    actionId: id,
    labelKo: getAction(id).labelKo,
    flavorKo: getAction(id).flavorKo,
  }));

  const payload = {
    day: ctx.day,
    opponent: {
      name: ctx.opponent.name,
      age: ctx.opponent.age,
      schoolOrJob: ctx.opponent.schoolOrJob,
      personality: ctx.opponent.personality,
      battleStyle: ctx.opponent.battleStyle,
      dialogueStyle: ctx.opponent.dialogueStyle,
    },
    battle: {
      round: ctx.battle.roundNumber,
      player_hp: ctx.battle.playerHp,
      opponent_hp: ctx.battle.opponentHp,
      distance: ctx.battle.distance,
      momentum: ctx.battle.momentum,
    },
    mechanical_result: ctx.mechanicalResult,
    allowed_choice_pool: allowedPool,
  };

  return `다음은 이번 턴의 확정된 전투 상황과 결과입니다. 이 수치를 바탕으로 한국어 서사와 선택지 문구만 작성하세요.\n\n${JSON.stringify(
    payload,
    null,
    2
  )}`;
}
