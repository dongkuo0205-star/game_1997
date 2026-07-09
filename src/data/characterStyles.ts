import { CharacterStyle } from "@/types/game";

// nameKo / description / signatureMove.nameKo are shown on screen — Korean only.
export const CHARACTER_STYLES: CharacterStyle[] = [
  {
    id: "flame_allrounder",
    nameKo: "화염 주인공형",
    description: "균형 잡힌 만능형. 연속기가 안정적이라 초보자에게 좋다. 직선 돌진, 상승 대공기, 3단 연속기가 특기.",
    statModifiers: { skill: 5, mind: 3, reaction: 2, combo: 5 },
    signatureMove: {
      baseActionId: "special_rush",
      nameKo: "불꽃 승룡 돌진",
    },
    preferredActions: ["special_rush", "combo_attempt", "anti_air"],
  },
  {
    id: "cold_burst",
    nameKo: "냉철 폭발형",
    description: "높은 순간 화력, 높은 리스크, 화려한 스타일. 돌진 잡기, 연속 압박, 역전 초필살기에 특화.",
    statModifiers: { skill: 7, mind: -2, reaction: 5, combo: 3 },
    signatureMove: {
      baseActionId: "super_move",
      nameKo: "빙인 절살",
    },
    preferredActions: ["super_move", "heavy_pressure", "grapple"],
  },
  {
    id: "grapple_power",
    nameKo: "잡기 파워형",
    description: "근접 압박이 강하지만 원거리 견제에 약하다. 잡기, 기상 압박, 강공격이 주무기.",
    statModifiers: { skill: 4, mind: 4, reaction: -2, combo: 2, family: 2 },
    signatureMove: {
      baseActionId: "grapple",
      nameKo: "백열 조르기",
    },
    preferredActions: ["grapple", "heavy_pressure", "crouch_block"],
  },
  {
    id: "speed_chaos",
    nameKo: "스피드 교란형",
    description: "이동이 빠르고 교란에 능하지만 데미지는 낮다. 점프 공격, 뒤로 돌기, 연속 경공격이 특기.",
    statModifiers: { skill: 2, mind: 2, reaction: 8, combo: 4 },
    signatureMove: {
      baseActionId: "reversal_combo",
      nameKo: "잔영 난무",
    },
    preferredActions: ["jump_attack", "feint", "bait_jump"],
  },
  {
    id: "heavy_wall",
    nameKo: "헤비 압박형",
    description: "체력이 두껍고 판정 범위가 넓지만 느리다. 강공격, 슈퍼아머, 구석 압박에 강하다.",
    statModifiers: { skill: 5, mind: 5, reaction: -3, combo: 1, stamina: 10 },
    signatureMove: {
      baseActionId: "rage_counter",
      nameKo: "강철 진각",
    },
    preferredActions: ["rage_counter", "heavy_pressure", "wait_counter"],
  },
];

export function getStyle(id: string): CharacterStyle {
  const style = CHARACTER_STYLES.find((s) => s.id === id);
  if (!style) throw new Error(`Unknown character style: ${id}`);
  return style;
}
