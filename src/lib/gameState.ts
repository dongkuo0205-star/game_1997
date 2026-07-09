import { CHARACTER_STYLES, getStyle } from "@/data/characterStyles";
import {
  CharacterStyleId,
  GameState,
  PlayerStats,
  StatChanges,
  StoryLogEntry,
} from "@/types/game";

export const MATCH_COST = 500;
export const PC_ROOM_EVENT_DAY = 40;
export const GRADUATION_DAY = 60;

const CLAMPED_KEYS: Array<keyof PlayerStats> = [
  "skill",
  "mind",
  "reaction",
  "combo",
  "fame",
  "stamina",
  "love",
  "family",
];

function clampStat(v: number): number {
  return Math.max(0, Math.min(100, v));
}

export function createInitialStats(): PlayerStats {
  return {
    money: 5000,
    skill: 40,
    mind: 35,
    reaction: 40,
    combo: 30,
    fame: 0,
    stamina: 100,
    love: 0,
    family: 50,
    win_streak: 0,
    total_wins: 0,
    total_losses: 0,
    day: 1,
  };
}

export function createInitialState(styleId: CharacterStyleId): GameState {
  const style = getStyle(styleId);
  const stats = createInitialStats();
  for (const [key, delta] of Object.entries(style.statModifiers)) {
    const k = key as keyof PlayerStats;
    (stats[k] as number) += delta as number;
  }
  for (const key of CLAMPED_KEYS) {
    stats[key] = clampStat(stats[key] as number);
  }

  return {
    version: 1,
    styleId,
    stats,
    flags: [],
    storyLog: [],
    currentBattle: null,
    currentChoices: [],
    currentOpponent: null,
    phase: "arcade_daily",
    endingId: null,
    lastStory: "",
  };
}

export function applyStatChanges(stats: PlayerStats, changes: StatChanges): PlayerStats {
  const next = { ...stats };
  for (const [key, delta] of Object.entries(changes)) {
    const k = key as keyof StatChanges;
    if (typeof delta !== "number") continue;
    if (k === "money") {
      next.money = Math.max(0, next.money + delta);
    } else {
      (next[k] as number) = clampStat((next[k] as number) + delta);
    }
  }
  return next;
}

export function applyMatchResult(stats: PlayerStats, won: boolean): PlayerStats {
  const next = { ...stats };
  if (won) {
    next.win_streak += 1;
    next.total_wins += 1;
  } else {
    next.win_streak = 0;
    next.total_losses += 1;
  }
  next.stamina = clampStat(next.stamina - 8);
  next.day += 1;
  return next;
}

export function makeLogEntry(
  day: number,
  kind: StoryLogEntry["kind"],
  text: string
): StoryLogEntry {
  return {
    id: `${day}-${kind}-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
    day,
    kind,
    text,
  };
}

export function isPcRoomEventDay(day: number): boolean {
  return day === PC_ROOM_EVENT_DAY;
}

export function isGraduationDay(day: number): boolean {
  return day >= GRADUATION_DAY;
}

export function canAffordMatch(stats: PlayerStats): boolean {
  return stats.money >= MATCH_COST;
}

export { CHARACTER_STYLES };
