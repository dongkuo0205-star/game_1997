"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import ArcadeHeader from "@/components/ArcadeHeader";
import StatusPanel from "@/components/StatusPanel";
import StoryLog from "@/components/StoryLog";
import EndingPage from "@/components/EndingPage";
import FightCanvas, { FightMatchResult } from "@/components/FightCanvas";
import { getEnding, resolveEnding } from "@/data/endings";
import { generateOpponent } from "@/data/opponents";
import { computeMatchGrowth } from "@/lib/battleEngine";
import {
  applyMatchResult,
  applyStatChanges,
  canAffordMatch,
  isGraduationDay,
  isPcRoomEventDay,
  makeLogEntry,
} from "@/lib/gameState";
import { loadGame, saveGame, clearSave } from "@/lib/storage";
import * as sfx from "@/lib/fight/sfx";
import { GameState, StoryLogEntry } from "@/types/game";

interface NarrativeOption {
  id: "A" | "B" | "C" | "D";
  text: string;
  apply: (state: GameState) => GameState;
}

function withLog(state: GameState, text: string, kind: StoryLogEntry["kind"] = "story"): GameState {
  return {
    ...state,
    storyLog: [...state.storyLog, makeLogEntry(state.stats.day, kind, text)],
  };
}

function addFlag(state: GameState, flag: string): GameState {
  if (state.flags.includes(flag)) return state;
  return { ...state, flags: [...state.flags, flag] };
}

function buildPcRoomOptions(): NarrativeOption[] {
  return [
    {
      id: "A",
      text: "오락실을 계속 지킨다",
      apply: (s) =>
        withLog(
          addFlag(s, "chose_arcade_route"),
          "너는 계속 오락실에 남기로 했다. 옆집 PC방의 불빛이 밤에도 환하게 켜져 있다."
        ),
    },
    {
      id: "B",
      text: "PC방에 가본다",
      apply: (s) =>
        withLog(
          addFlag(s, "chose_pc_room_route"),
          "호기심에 PC방 문을 열었다. 낯선 게임 화면 속, 작은 일꾼들이 분주히 움직이고 있었다."
        ),
    },
    {
      id: "C",
      text: "둘 다 해본다",
      apply: (s) =>
        withLog(
          addFlag(addFlag(s, "chose_pc_room_route"), "chose_arcade_route"),
          "너는 두 곳을 오가기로 했다. 오락실과 PC방, 두 시대가 잠시 함께 존재했다."
        ),
    },
    {
      id: "D",
      text: "마지막 오락실 대회에 참가한다",
      apply: (s) =>
        withLog(
          addFlag(addFlag(s, "stayed_till_the_end"), "chose_arcade_route"),
          "오락실이 마련한 마지막 대회 공지가 붙었다. 너는 참가 신청서에 이름을 적었다."
        ),
    },
  ];
}

function buildConfessionOptions(): NarrativeOption[] {
  return [
    {
      id: "A",
      text: "고백한다",
      apply: (s) => {
        const success = s.stats.family >= 30;
        const flagged = addFlag(s, success ? "confession_success" : "confession_failed");
        const text = success
          ? "떨리는 목소리로 마음을 전했다. 그녀는 잠시 놀란 얼굴이었다가, 이내 웃었다."
          : "마음을 전했지만, 너무 늦은 타이밍이었을지도 모른다.";
        return withLog(flagged, text);
      },
    },
    {
      id: "B",
      text: "고백하지 않는다",
      apply: (s) => withLog(s, "결국 하고 싶은 말을 삼켰다. 졸업식 종이 울렸다."),
    },
  ];
}

export default function GamePage() {
  const router = useRouter();
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const loaded = loadGame();
    if (!loaded) {
      router.replace("/");
      return;
    }
    setGameState(loaded);
  }, [router]);

  useEffect(() => {
    if (gameState) saveGame(gameState);
  }, [gameState]);

  const advanceAfterMatch = useCallback(
    (state: GameState, wonMatch: boolean, opponentType: string): GameState => {
      let next = { ...state, stats: applyMatchResult(state.stats, wonMatch) };
      if (opponentType === "legend" && wonMatch) next = addFlag(next, "beat_legend");
      if (next.stats.total_wins >= 15) next = addFlag(next, "boss_trust_high");

      if (isGraduationDay(next.stats.day)) {
        if (next.stats.love >= 80 && !next.flags.includes("confession_success") && !next.flags.includes("confession_failed")) {
          return { ...next, currentBattle: null, currentChoices: [], currentOpponent: null, phase: "graduation" };
        }
        const ending = resolveEnding(next.stats, next.flags);
        return withLog(
          { ...next, currentBattle: null, currentChoices: [], currentOpponent: null, phase: "ending", endingId: ending.id },
          ending.text,
          "system"
        );
      }

      if (isPcRoomEventDay(next.stats.day) && !next.flags.includes("pc_room_event_done")) {
        return {
          ...addFlag(next, "pc_room_event_done"),
          currentBattle: null,
          currentChoices: [],
          currentOpponent: null,
          phase: "pc_room_event",
        };
      }

      return { ...next, currentBattle: null, currentChoices: [], currentOpponent: null, phase: "arcade_daily" };
    },
    []
  );

  const handleStartMatch = useCallback(() => {
    if (!gameState) return;
    if (!canAffordMatch(gameState.stats)) {
      setError("돈이 부족합니다. 오늘은 더 이상 도전할 수 없습니다.");
      return;
    }
    setError(null);
    sfx.unlock();
    sfx.coin();
    const opponent = generateOpponent(gameState.stats);
    const newStats = { ...gameState.stats, money: gameState.stats.money - 500 };
    setGameState(
      withLog(
        { ...gameState, stats: newStats, currentOpponent: opponent, phase: "battle" },
        `오늘의 상대: ${opponent.name} (${opponent.schoolOrJob})`,
        "system"
      )
    );
  }, [gameState]);

  const handlePartTimeJob = useCallback(() => {
    if (!gameState) return;
    const stats = {
      ...gameState.stats,
      money: gameState.stats.money + 1500,
      stamina: Math.max(0, gameState.stats.stamina - 10),
      day: gameState.stats.day + 1,
    };
    setGameState(
      withLog(
        { ...gameState, stats },
        "새벽부터 신문을 돌렸다. 손은 시리지만 주머니에 1,500원이 생겼다.",
        "system"
      )
    );
  }, [gameState]);

  const handleFightEnd = useCallback(
    (result: FightMatchResult) => {
      if (!gameState || !gameState.currentOpponent) return;
      const opponent = gameState.currentOpponent;
      const growth = computeMatchGrowth(result.won, result.comeback, result.landedAntiAir, result.landedCombo);
      const statedStats = applyStatChanges(gameState.stats, growth);
      let next: GameState = withLog(
        { ...gameState, stats: statedStats },
        result.won ? `${opponent.name}을(를) 이겼다!` : `${opponent.name}에게 졌다...`,
        "battle"
      );
      next = advanceAfterMatch(next, result.won, opponent.type);
      setGameState(next);
    },
    [gameState, advanceAfterMatch]
  );

  const handleNarrativeChoice = useCallback(
    (option: NarrativeOption) => {
      if (!gameState) return;
      let next = option.apply(gameState);
      if (next.phase === "graduation") {
        const ending = resolveEnding(next.stats, next.flags);
        next = withLog(
          { ...next, phase: "ending", endingId: ending.id },
          ending.text,
          "system"
        );
      } else {
        next = { ...next, phase: "arcade_daily" };
      }
      setGameState(next);
    },
    [gameState]
  );

  const handleRestart = useCallback(() => {
    clearSave();
    router.replace("/");
  }, [router]);

  const handleViewEpilogue = useCallback(() => {
    if (!gameState) return;
    const ending = getEnding("farewell_oraksil");
    setGameState(
      withLog({ ...gameState, phase: "ending", endingId: ending.id }, ending.text, "system")
    );
  }, [gameState]);

  if (!gameState) {
    return <div className="flex min-h-screen items-center justify-center bg-arcade-bg text-arcade-cyan">불러오는 중...</div>;
  }

  if (gameState.phase === "ending" && gameState.endingId) {
    const ending = getEnding(gameState.endingId);
    return (
      <EndingPage
        ending={ending}
        stats={gameState.stats}
        onRestart={handleRestart}
      />
    );
  }

  const narrativeOptions =
    gameState.phase === "pc_room_event"
      ? buildPcRoomOptions()
      : gameState.phase === "graduation"
      ? buildConfessionOptions()
      : null;

  if (gameState.phase === "battle" && gameState.currentOpponent) {
    return (
      <div className="min-h-screen bg-arcade-bg pb-8">
        <ArcadeHeader day={gameState.stats.day} money={gameState.stats.money} />
        <main className="mx-auto max-w-3xl px-4 py-4">
          <FightCanvas
            key={gameState.currentOpponent.id}
            opponent={gameState.currentOpponent}
            onEnd={handleFightEnd}
            winStreak={gameState.stats.win_streak}
          />
        </main>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-arcade-bg pb-8">
      <ArcadeHeader day={gameState.stats.day} money={gameState.stats.money} />

      <main className="mx-auto grid max-w-4xl grid-cols-1 gap-4 px-4 py-4 sm:grid-cols-3">
        <div className="order-2 space-y-3 sm:order-1">
          <StatusPanel stats={gameState.stats} />
        </div>

        <div className="order-1 space-y-3 sm:order-2 sm:col-span-2">
          <StoryLog entries={gameState.storyLog} />

          {error && <p className="rounded bg-red-900/50 px-3 py-2 text-xs text-red-200">{error}</p>}

          {gameState.phase === "arcade_daily" && (
            <button
              onClick={handleStartMatch}
              className="w-full rounded border-2 border-arcade-neon bg-arcade-panel py-4 font-arcade text-sm text-arcade-yellow shadow-neon hover:bg-arcade-neon hover:text-black"
            >
              <span className="animate-pulse">▶ INSERT COIN ◀</span>
              <span className="mt-1 block text-[10px] text-arcade-cyan">동전을 넣는다 (500원)</span>
            </button>
          )}

          {gameState.phase === "arcade_daily" && gameState.stats.money < 500 && (
            <button
              onClick={handlePartTimeJob}
              className="w-full rounded border-2 border-arcade-yellow/70 bg-arcade-panel py-3 font-arcade text-[10px] text-arcade-yellow hover:bg-arcade-yellow hover:text-black"
            >
              신문 배달 아르바이트 (+1,500원 · 하루 지남)
            </button>
          )}

          {narrativeOptions && (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {narrativeOptions.map((opt) => (
                <button
                  key={opt.id}
                  onClick={() => handleNarrativeChoice(opt)}
                  className="rounded border-2 border-arcade-cyan/60 bg-arcade-panel px-3 py-2 text-left text-sm text-white hover:border-arcade-neon hover:shadow-neon"
                >
                  <span className="mr-2 font-arcade text-[10px] text-arcade-yellow">{opt.id}</span>
                  {opt.text}
                </button>
              ))}
            </div>
          )}

          {gameState.phase === "arcade_daily" && gameState.stats.day > 1 && (
            <button
              onClick={handleViewEpilogue}
              className="w-full text-center text-[10px] text-gray-500 underline hover:text-gray-300"
            >
              (몇 년 후, 그곳에 가보다)
            </button>
          )}
        </div>
      </main>
    </div>
  );
}
