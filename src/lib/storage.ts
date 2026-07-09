import { GameState } from "@/types/game";

const SAVE_KEY = "orakssil1997_save_v1";

export function saveGame(state: GameState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  } catch {
    // localStorage can throw in private-browsing/quota-exceeded cases; the
    // game should keep running in-memory even if persistence fails.
  }
}

export function loadGame(): GameState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as GameState;
    if (parsed.version !== 1) return null;

    // Saves from older builds may miss newer fields or be stuck mid-battle
    // (fight state itself is never persisted). Normalize back to the arcade
    // lobby so the game always loads into an actionable screen.
    if (parsed.currentOpponent === undefined) parsed.currentOpponent = null;
    if (parsed.currentChoices === undefined) parsed.currentChoices = [];
    if (parsed.phase === "battle" || (parsed.phase as string) === undefined) {
      parsed.phase = "arcade_daily";
      parsed.currentBattle = null;
      parsed.currentChoices = [];
      parsed.currentOpponent = null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearSave(): void {
  if (typeof window === "undefined") return;
  window.localStorage.removeItem(SAVE_KEY);
}

export function hasSave(): boolean {
  return loadGame() !== null;
}
