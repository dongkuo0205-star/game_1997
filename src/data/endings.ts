import { Ending, EndingId, PlayerStats } from "@/types/game";

// nameKo / text are the only fields ever rendered — Korean only.
// devConditionNote is for developers reading this file, never shown in-game.
const ENDINGS: Record<EndingId, Ending> = {
  arcade_legend: {
    id: "arcade_legend",
    nameKo: "오락실 전설",
    devConditionNote: "fame 高、总胜场高、击败最终高手",
    text:
      "졸업식 날, 오락실 벽에는 네 이름과 연승 기록이 붙어 있었다. 김 사장은 조이스틱을 새것으로 바꿨지만," +
      " 네가 닳도록 쓰던 낡은 조이스틱만은 카운터 서랍에 넣고 잠가두었다.\n\n" +
      "\"이건, 아무도 손대지 마.\" 그는 담배를 문 채 말했다. \"이 오락실의 전설이 쓰던 거니까.\"",
  },
  first_love_success: {
    id: "first_love_success",
    nameKo: "첫사랑 성공",
    devConditionNote: "love 高、family 不能太低",
    text:
      "졸업식이 끝난 뒤, 지은이가 교문 앞에서 기다리고 있었다. 손에는 콜라 한 캔, 네가 처음 사줬던 것과 똑같았다.\n\n" +
      "\"이제는,\" 그녀가 말했다. \"내가 살 차례야.\"",
  },
  ordinary_graduate: {
    id: "ordinary_graduate",
    nameKo: "평범한 졸업",
    devConditionNote: "没有明显特殊路线",
    text:
      "너는 무사히 졸업했다. 전설이 되지도, 대단한 사랑을 이루지도 못했다.\n\n" +
      "하지만 수업이 끝나자마자 오락실로 달려가던 그 시절들, 그거면 충분했던 것 같다.",
  },
  pc_room_convert: {
    id: "pc_room_convert",
    nameKo: "PC방 전향 게이머",
    devConditionNote: "后期选择StarCraft路线",
    text:
      "너는 대부분의 시간을 옆에 새로 생긴 PC방에서 보내게 됐다. 키보드가 조이스틱을 대신했고," +
      " 유닛을 지휘하는 것이 콤보를 잇는 것을 대신했다.\n\n" +
      "가끔 동전 넣는 소리가 그리울 때도 있지만, 1998년의 바람은 이미 다른 방향으로 불고 있었다.",
  },
  esports_rookie: {
    id: "esports_rookie",
    nameKo: "프로게이머의 싹",
    devConditionNote: "skill、reaction 极高，且开启PC房线",
    text:
      "누군가는 네 스타크래프트 손속도가 그 시절 오락실에서 다져진 거라고 말한다.\n\n" +
      "\"프로게이머\"라는 직업이 미래에 정말 생길지는 아무도 모르지만, 너는 계속 해보기로 마음먹었다.",
  },
  last_champion: {
    id: "last_champion",
    nameKo: "오락실 마지막 챔피언",
    devConditionNote: "在街机厅衰落事件中坚持到底",
    text:
      "오락실 손님은 점점 줄어들었지만, 너는 떠나지 않았다.\n\n" +
      "마지막 경기, 관객은 김 사장 한 명뿐이었다. 그는 박수를 쳐주었고, 텅 빈 가게 안에서 그 소리는 유난히 크게 울렸다.",
  },
  family_broken: {
    id: "family_broken",
    nameKo: "가족 붕괴 엔딩",
    devConditionNote: "family 过低、money 长期归零",
    text:
      "너는 이미 오랫동안 집에서 제대로 밥을 먹은 적이 없었다.\n\n" +
      "졸업식 날 아무도 오지 않았다. 오락실 사장님만 콜라 한 캔을 건네주고는, 아무 말도 하지 않았다.",
  },
  youth_regret: {
    id: "youth_regret",
    nameKo: "청춘의 아쉬움",
    devConditionNote: "love 高但毕业时表白失败",
    text:
      "졸업식 날, 너는 마침내 하고 싶었던 말을 꺼냈다.\n\n" +
      "하지만 어떤 타이밍은 한 번 놓치면 평생이다 — 그녀는 그저 웃으며 말했다. \"말해줘서 고마워.\"",
  },
  boss_heir: {
    id: "boss_heir",
    nameKo: "사장님의 후계자",
    devConditionNote: "与金叔关系高、坚持街机厅路线",
    text:
      "\"야, 고등학생.\" 김 사장이 카운터 열쇠를 네 손에 쥐여줬다. \"이제부터 여기, 네가 맡아라.\"\n\n" +
      "너는 멍하니 서 있었다. 그는 고개를 돌리며 재떨이를 닦는 척했다.",
  },
  farewell_oraksil: {
    id: "farewell_oraksil",
    nameKo: "안녕, 오락실",
    devConditionNote: "隐藏结局：多年后旧地重游",
    text:
      "몇 년 후, 그 거리를 지나며 그때 그 오락실을 찾아봤다.\n\n" +
      "그 자리엔 편의점이 들어서 있었다. 조명은 밝고 깨끗했지만, 아무것도 남아있지 않았다 — 네 머릿속에" +
      " 1997년에 멈춰버린 그 외침만 빼고. \"한 판 더!\"",
  },
};

export function resolveEnding(stats: PlayerStats, flags: string[]): Ending {
  const hasFlag = (f: string) => flags.includes(f);

  if (hasFlag("pc_room_ending_check")) {
    return ENDINGS.farewell_oraksil;
  }
  if (stats.family <= 15 && stats.money <= 0) {
    return ENDINGS.family_broken;
  }
  if (
    stats.fame >= 70 &&
    stats.total_wins >= 25 &&
    hasFlag("beat_legend")
  ) {
    return ENDINGS.arcade_legend;
  }
  if (stats.love >= 80 && hasFlag("confession_success")) {
    return ENDINGS.first_love_success;
  }
  if (stats.love >= 80 && hasFlag("confession_failed")) {
    return ENDINGS.youth_regret;
  }
  if (hasFlag("boss_trust_high") && hasFlag("chose_arcade_route")) {
    return ENDINGS.boss_heir;
  }
  if (hasFlag("stayed_till_the_end")) {
    return ENDINGS.last_champion;
  }
  if (stats.skill >= 85 && stats.reaction >= 85 && hasFlag("chose_pc_room_route")) {
    return ENDINGS.esports_rookie;
  }
  if (hasFlag("chose_pc_room_route")) {
    return ENDINGS.pc_room_convert;
  }
  return ENDINGS.ordinary_graduate;
}

export function getEnding(id: EndingId): Ending {
  return ENDINGS[id];
}
