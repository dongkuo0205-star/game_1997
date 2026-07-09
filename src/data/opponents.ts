import { ActionId, Opponent, OpponentType, PlayerStats } from "@/types/game";

// All display strings below (schoolOrJob/personality/battleStyle/dialogueStyle)
// are shown directly in the OpponentCard — Korean only.
interface OpponentTemplate {
  type: OpponentType;
  names: string[];
  schoolOrJob: string[];
  personality: string;
  battleStyle: string;
  favoriteTactics: ActionId[];
  weaknesses: ActionId[];
  dialogueStyle: string;
  baseDifficulty: number; // 1..5, further scaled by day/fame
  ageRange: [number, number];
}

const TEMPLATES: OpponentTemplate[] = [
  {
    type: "classmate_novice",
    names: ["박민수", "이도현", "김태준"],
    schoolOrJob: ["같은 반 친구"],
    personality: "덤벙대지만 순수하게 게임을 즐긴다",
    battleStyle: "버튼을 마구 누르는 두서없는 스타일",
    favoriteTactics: ["jump_attack", "combo_attempt"],
    weaknesses: ["wait_counter", "anti_air"],
    dialogueStyle: "말만 앞선다: \"간다, 각오해!\"",
    baseDifficulty: 1,
    ageRange: [16, 17],
  },
  {
    type: "rival_class_ace",
    names: ["최영진", "강민호"],
    schoolOrJob: ["옆 반 학생"],
    personality: "자신만만하고 구경꾼들 앞에서 뽐내길 좋아함",
    battleStyle: "점프 압박 위주, 가끔 간단한 콤보를 넣는다",
    favoriteTactics: ["jump_attack", "combo_attempt", "heavy_pressure"],
    weaknesses: ["anti_air", "wait_counter"],
    dialogueStyle: "도발하듯 웃는다: \"겨우 이 정도야?\"",
    baseDifficulty: 2,
    ageRange: [16, 18],
  },
  {
    type: "vocational_senior",
    names: ["오형준", "배정우"],
    schoolOrJob: ["공업고등학교 선배"],
    personality: "공격적이고 말투가 거칠다",
    battleStyle: "거친 압박과 도발을 함께 섞는 스타일",
    favoriteTactics: ["heavy_pressure", "taunt", "grapple"],
    weaknesses: ["back_step", "anti_air"],
    dialogueStyle: "말투가 세다: \"꼬맹아, 아직도 안 죽었냐?\"",
    baseDifficulty: 3,
    ageRange: [18, 19],
  },
  {
    type: "arcade_regular",
    names: ["장현우"],
    schoolOrJob: ["오락실 단골"],
    personality: "말이 적고 계속 상대를 관찰한다",
    battleStyle: "심리전에 능하며 플레이어의 버릇을 파고든다",
    favoriteTactics: ["pause_bait", "bait_jump", "feint"],
    weaknesses: ["combo_attempt", "grapple"],
    dialogueStyle: "말수가 적다, 이길 때만 고개를 끄덕인다",
    baseDifficulty: 3,
    ageRange: [19, 22],
  },
  {
    type: "legend",
    names: ["백승호"],
    schoolOrJob: ["전설의 고수"],
    personality: "차분하고 실수가 거의 없다",
    battleStyle: "만능형, 상대 스타일에 맞춰 전술을 바꾼다",
    favoriteTactics: ["wait_counter", "super_move", "anti_air"],
    weaknesses: ["reversal_combo"],
    dialogueStyle: "말은 적지만 핵심을 찌른다: \"아직 한 끗 부족해.\"",
    baseDifficulty: 5,
    ageRange: [20, 25],
  },
  {
    type: "child_prodigy",
    names: ["꼬마 지훈"],
    schoolOrJob: ["동네 초등학생"],
    personality: "순진해 보이지만 반응 속도가 무섭도록 빠르다",
    battleStyle: "상대가 먼저 움직이길 기다렸다가 반격하는 타입",
    favoriteTactics: ["wait_counter", "feint", "anti_air"],
    weaknesses: ["grapple", "taunt"],
    dialogueStyle: "천진난만한 말투: \"형, 졌잖아.\"",
    baseDifficulty: 3,
    ageRange: [10, 12],
  },
  {
    type: "soldier_on_leave",
    names: ["김병장"],
    schoolOrJob: ["휴가 나온 군인"],
    personality: "노련하고 침착하며 수비가 매우 단단하다",
    battleStyle: "수비 반격형, 잡기가 강력하다",
    favoriteTactics: ["crouch_block", "grapple", "wait_counter"],
    weaknesses: ["back_step", "jump_attack"],
    dialogueStyle: "확신에 찬 말투: \"젊은이, 침착하게 가자고.\"",
    baseDifficulty: 4,
    ageRange: [21, 23],
  },
  {
    type: "girl_gamer",
    names: ["이수아"],
    schoolOrJob: ["다른 학교 여고생"],
    personality: "차분하고 말수가 적으며 자연스럽게 주목을 끈다",
    battleStyle: "군더더기 없는 깔끔한 플레이",
    favoriteTactics: ["low_poke", "combo_attempt", "back_step"],
    weaknesses: ["grapple", "heavy_pressure"],
    dialogueStyle: "예의 바르지만 거리감 있는 말투: \"잘 봤어요.\"",
    baseDifficulty: 3,
    ageRange: [16, 18],
  },
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function generateOpponent(stats: PlayerStats): Opponent {
  const pool = TEMPLATES.filter((t) => {
    // Legend only appears once the player has built some reputation.
    if (t.type === "legend") return stats.fame >= 60 || stats.total_wins >= 20;
    return true;
  });
  const template = pick(pool);
  const [minAge, maxAge] = template.ageRange;
  const age = minAge + Math.floor(Math.random() * (maxAge - minAge + 1));

  // Scale difficulty gently with the player's own growth so it stays a fair fight.
  const growthBonus = Math.floor((stats.fame + stats.total_wins * 2) / 30);
  const difficulty = Math.min(5, template.baseDifficulty + Math.min(2, growthBonus));

  const skill = 25 + difficulty * 10 + Math.floor(Math.random() * 8);
  const reaction = 20 + difficulty * 9 + Math.floor(Math.random() * 8);
  const mind = 20 + difficulty * 8 + Math.floor(Math.random() * 8);

  return {
    id: `${template.type}-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    type: template.type,
    name: pick(template.names),
    age,
    schoolOrJob: pick(template.schoolOrJob),
    personality: template.personality,
    battleStyle: template.battleStyle,
    favoriteTactic: pick(template.favoriteTactics),
    weakness: pick(template.weaknesses),
    difficulty,
    dialogueStyle: template.dialogueStyle,
    skill,
    reaction,
    mind,
  };
}
