// ============================================================================
// 오락실 1997 (街机厅1997) — core type definitions
// ============================================================================

export type ActionCategory = "attack" | "defense" | "mental" | "highrisk";

export type ActionId =
  | "jump_attack" // 前跳攻击
  | "low_poke" // 下段试探
  | "heavy_pressure" // 重拳压制
  | "combo_attempt" // 连招尝试
  | "special_rush" // 必杀技突进
  | "back_step" // 后撤
  | "crouch_block" // 下蹲防守
  | "anti_air" // 防空
  | "observe" // 观察对手
  | "wait_counter" // 等待反击
  | "feint" // 假动作
  | "taunt" // 挑衅
  | "pause_bait" // 故意停顿
  | "bait_jump" // 诱导对方跳入
  | "super_move" // 超必杀
  | "grapple" // 投技
  | "rage_counter" // 爆气反击
  | "reversal_combo"; // 逆转连招

export interface ActionDef {
  id: ActionId;
  category: ActionCategory;
  // NOTE: labelKo/flavorKo are the ONLY text from this record ever shown
  // in-game or sent to the narrator — the game screen must be Korean-only.
  labelKo: string;
  risk: number; // 0..1, higher = swingier outcomes
  baseDamage: number;
  meterGain: number;
  meterCost: number; // required meter to even attempt (0 for normal moves)
  /** Actions this move beats outright (favorable matchup). */
  beats: ActionId[];
  /** Actions this move loses hard to (unfavorable matchup). */
  losesTo: ActionId[];
  flavorKo: string; // short Korean hint used to steer narration
}

export type CharacterStyleId =
  | "flame_allrounder" // 火焰主角型
  | "cold_burst" // 冷酷爆发型
  | "grapple_power" // 投技力量型
  | "speed_chaos" // 速度扰乱型
  | "heavy_wall"; // 大体型压制型

export interface CharacterStyle {
  id: CharacterStyleId;
  // Korean-only: nameKo/description/signatureMove.nameKo are shown on screen.
  nameKo: string;
  description: string;
  statModifiers: Partial<PlayerStats>;
  signatureMove: {
    baseActionId: ActionId;
    nameKo: string;
  };
  preferredActions: ActionId[];
}

export type OpponentType =
  | "classmate_novice" // 同班新手
  | "rival_class_ace" // 隔壁班高手
  | "vocational_senior" // 职高学长
  | "arcade_regular" // 街机厅常客
  | "legend" // 传说级高手
  | "child_prodigy" // 小学生天才
  | "soldier_on_leave" // 军队休假大哥
  | "girl_gamer"; // 女高中生玩家

export interface Opponent {
  // Korean-only: every string field below is rendered directly in-game.
  id: string;
  type: OpponentType;
  name: string;
  age: number;
  schoolOrJob: string;
  personality: string;
  battleStyle: string;
  favoriteTactic: ActionId;
  weakness: ActionId;
  difficulty: number; // 1..5
  dialogueStyle: string;
  skill: number;
  reaction: number;
  mind: number;
}

export interface PlayerStats {
  money: number;
  skill: number;
  mind: number;
  reaction: number;
  combo: number;
  fame: number;
  stamina: number;
  love: number;
  family: number;
  win_streak: number;
  total_wins: number;
  total_losses: number;
  day: number;
}

export type Distance = "close" | "mid" | "far";
export type Momentum = "player" | "opponent" | "neutral";

export interface BattleState {
  opponent: Opponent;
  playerHp: number;
  opponentHp: number;
  playerMeter: number;
  opponentMeter: number;
  roundNumber: 1 | 2 | 3;
  playerRoundsWon: number;
  opponentRoundsWon: number;
  distance: Distance;
  momentum: Momentum;
  exchangeCount: number;
  matchOver: boolean;
  playerWonMatch?: boolean;
}

export interface Choice {
  id: "A" | "B" | "C";
  text: string;
  actionId: ActionId;
}

export type StoryLogKind = "story" | "battle" | "system" | "ending";

export interface StoryLogEntry {
  id: string;
  day: number;
  kind: StoryLogKind;
  text: string;
}

export type GamePhase =
  | "intro"
  | "arcade_daily"
  | "battle"
  | "pc_room_event"
  | "graduation"
  | "ending";

export type EndingId =
  | "arcade_legend"
  | "first_love_success"
  | "ordinary_graduate"
  | "pc_room_convert"
  | "esports_rookie"
  | "last_champion"
  | "family_broken"
  | "youth_regret"
  | "boss_heir"
  | "farewell_oraksil";

export interface Ending {
  id: EndingId;
  // Korean-only display fields:
  nameKo: string;
  text: string;
  // Internal dev note (condition summary) — never rendered in-game.
  devConditionNote: string;
}

export interface GameState {
  version: 1;
  styleId: CharacterStyleId;
  stats: PlayerStats;
  flags: string[];
  storyLog: StoryLogEntry[];
  currentBattle: BattleState | null;
  currentChoices: Choice[];
  currentOpponent: Opponent | null;
  phase: GamePhase;
  endingId: EndingId | null;
  lastStory: string;
}

// ---- API contracts (Claude / mock narrator) --------------------------------

export interface StatChanges {
  money?: number;
  skill?: number;
  mind?: number;
  reaction?: number;
  combo?: number;
  fame?: number;
  love?: number;
  family?: number;
  stamina?: number;
}

export interface BattleTurnResultPayload {
  story: string;
  battle: {
    round: number;
    player_hp: number;
    opponent_hp: number;
    distance: Distance;
    momentum: Momentum;
    result: string;
  };
  // Full mechanical state the client must echo back on the next turn — the
  // server holds no session, so this is the only continuity mechanism.
  battle_state: BattleState;
  stat_changes: StatChanges;
  choices: Choice[];
  flags: string[];
  match_over: boolean;
  player_won_match?: boolean;
}

export interface BattleTurnRequest {
  stats: PlayerStats;
  battle: BattleState;
  chosenActionId: ActionId;
}

export interface StartMatchRequest {
  stats: PlayerStats;
  styleId: CharacterStyleId;
}

export interface StartMatchResponsePayload {
  story: string;
  opponent: Opponent;
  battle: BattleTurnResultPayload["battle"];
  battle_state: BattleState;
  choices: Choice[];
  matchCost: number;
}
