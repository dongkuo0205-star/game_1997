import { getAction } from "@/data/actions";
import { ActionId, Choice } from "@/types/game";
import { NarratorContext } from "@/lib/prompts";

// Local fallback narrator used when no ANTHROPIC_API_KEY is configured.
// Produces the same { story, choices } contract as the Claude narrator,
// entirely in Korean, using deterministic templates over the mechanical
// result that battleEngine.ts already computed.

const CROWD_LINES = [
  "동전 넣는 소리가 딸깍 울린다.",
  "조이스틱 부딪히는 소리가 요란하다.",
  "버튼 두드리는 소리가 점점 빨라진다.",
  "구경하던 애들이 소리를 지른다. \"우와!!\"",
  "사장님은 담배를 문 채 조용히 지켜본다.",
  "구석에서 컵라면 먹던 애가 젓가락을 멈췄다.",
  "누군가 외친다. \"한 판 더!!\"",
  "누군가 콜라를 걸고 내기를 하고 있다.",
  "뒤에서 훈수 두는 소리가 들린다. \"거기서 그거 아니지!\"",
  "누군가 중얼거린다. \"쟤 좀 하는데?\"",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function maybeCrowdLine(chance = 0.45): string {
  return Math.random() < chance ? ` ${pick(CROWD_LINES)}` : "";
}

function buildChoices(candidateActionIds: ActionId[]): Choice[] {
  const ids: Array<"A" | "B" | "C"> = ["A", "B", "C"];
  return candidateActionIds.slice(0, 3).map((actionId, i) => ({
    id: ids[i],
    text: getAction(actionId).labelKo,
    actionId,
  }));
}

export function mockNarrateMatchStart(ctx: NarratorContext): { story: string; choices: Choice[] } {
  const { opponent, day } = ctx;
  const story =
    `${day}일째. 오늘의 상대는 ${opponent.name}(${opponent.age}세, ${opponent.schoolOrJob})다.\n` +
    `"${opponent.dialogueStyle}"\n\n` +
    `${opponent.personality}. ${opponent.battleStyle}.\n` +
    `동전을 넣는다. 화면에 불이 들어온다.${maybeCrowdLine(0.6)}`;
  return { story, choices: buildChoices(ctx.candidateActionIds) };
}

export function mockNarrateExchange(ctx: NarratorContext): { story: string; choices: Choice[] } {
  const mr = ctx.mechanicalResult!;
  const oppName = ctx.opponent.name;
  const pMove = mr.playerActionKo;
  const oMove = mr.opponentActionKo;

  let line: string;
  switch (mr.resultKind) {
    case "player_hit":
      line = `너는 ${pMove}을(를) 선택했다. ${oppName}이(가) 미처 반응하지 못했다 — 그대로 꽂혔다! 상대 체력 -${mr.damageToOpponent}.`;
      break;
    case "opponent_hit":
      line = `너는 ${pMove}을(를) 시도했지만, ${oppName}의 ${oMove}이(가) 먼저 들어왔다. 너의 체력 -${mr.damageToPlayer}.`;
      break;
    case "trade_hit":
      line = `너의 ${pMove}과(와) ${oppName}의 ${oMove}이(가) 정면으로 부딪혔다! 서로 얻어맞았다. 너의 체력 -${mr.damageToPlayer}, 상대 체력 -${mr.damageToOpponent}.`;
      break;
    case "player_blocked":
      line = `너는 ${pMove} 자세를 취했지만, ${oppName}의 ${oMove}을(를) 완전히 막아내지 못했다. 너의 체력 -${mr.damageToPlayer}.`;
      break;
    case "opponent_blocked":
      line = `${oppName}이(가) ${pMove}을(를) 막아보려 했지만 완전히 피하지 못했다. 상대 체력 -${mr.damageToOpponent}.`;
      break;
    case "player_reversed":
      line = `그 순간, ${oppName}의 눈빛이 바뀌었다. 너의 ${pMove}이(가) 읽혔다 — 그대로 반격당했다! 너의 체력 -${mr.damageToPlayer}.`;
      break;
    case "opponent_reversed":
      line = `너는 ${oppName}의 수를 완전히 읽었다. ${oMove}이(가) 나오는 순간을 파고들어 반격했다! 상대 체력 -${mr.damageToOpponent}.`;
      break;
    default:
      line = `팽팽한 신경전이 이어진다. 아무도 먼저 움직이지 않았다.`;
  }

  let tail = "";
  if (mr.matchOver) {
    tail = mr.playerWonMatch
      ? `\n\n케이오!! 오락실이 순간 조용해졌다. 그리고 누군가 박수를 치기 시작했다.`
      : `\n\n패배. 화면에는 "CONTINUE?"가 깜빡인다. 누군가 어깨를 툭 치고 지나간다.`;
  } else if (mr.roundOver) {
    tail = mr.playerWonRound
      ? `\n\n${ctx.battle.roundNumber}라운드, 네가 가져갔다.`
      : `\n\n${ctx.battle.roundNumber}라운드를 내줬다. 아직 끝나지 않았다.`;
  } else {
    tail = maybeCrowdLine();
  }

  return { story: `${line}${tail}`, choices: buildChoices(ctx.candidateActionIds) };
}
