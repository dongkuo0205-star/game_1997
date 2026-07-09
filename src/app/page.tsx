"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { CHARACTER_STYLES } from "@/data/characterStyles";
import { createInitialState } from "@/lib/gameState";
import { hasSave, loadGame, saveGame } from "@/lib/storage";
import { CharacterStyleId } from "@/types/game";

export default function HomePage() {
  const router = useRouter();
  const [canContinue, setCanContinue] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selectedId, setSelectedId] = useState<CharacterStyleId>(CHARACTER_STYLES[0].id);

  useEffect(() => {
    setCanContinue(hasSave());
  }, []);

  const handleContinue = () => {
    if (!loadGame()) return;
    router.push("/game");
  };

  const handleStartNew = () => {
    const state = createInitialState(selectedId);
    saveGame(state);
    router.push("/game");
  };

  // Arcade convention: PRESS START itself starts the game — continue an
  // existing run if one is saved, otherwise open character select.
  const handlePressStart = () => {
    if (hasSave()) {
      handleContinue();
    } else {
      setSelecting(true);
    }
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (selecting) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handlePressStart();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selecting]);

  return (
    <div className="crt flex min-h-screen flex-col items-center justify-center gap-8 bg-arcade-bg px-4 py-10 text-center">
      <div>
        <p className="mb-3 font-arcade text-[10px] tracking-[0.4em] text-arcade-cyan">SINCE 1997 · SEOUL</p>
        <h1 className="neon-title font-arcade text-3xl text-arcade-neon sm:text-5xl">
          오락실 1997
        </h1>
        {!selecting && (
          <button
            type="button"
            onClick={handlePressStart}
            className="blink-slow mt-5 cursor-pointer font-arcade text-[11px] text-arcade-yellow hover:text-arcade-neon"
          >
            ▶ PRESS START ◀
          </button>
        )}
        <p className="mt-4 max-w-md text-sm leading-relaxed text-gray-300">
          1997년, 서울. 학교 앞 작은 오락실.
          <br />
          매일 방과 후, 동전을 넣고 한 판 붙는다.
          <br />
          연승과 명성, 그리고 그 시절의 첫사랑까지 — 청춘이 걸린 승부.
        </p>
      </div>

      {!selecting && (
        <div className="flex flex-col gap-3">
          {canContinue && (
            <button
              onClick={handleContinue}
              className="rounded border-2 border-arcade-cyan bg-arcade-panel px-8 py-3 font-arcade text-xs text-arcade-cyan shadow-cyan hover:bg-arcade-cyan hover:text-black"
            >
              이어하기
            </button>
          )}
          <button
            onClick={() => setSelecting(true)}
            className="rounded border-2 border-arcade-neon bg-arcade-panel px-8 py-3 font-arcade text-xs text-arcade-neon shadow-neon hover:bg-arcade-neon hover:text-black"
          >
            새로운 이야기 시작하기
          </button>
        </div>
      )}

      {selecting && (
        <div className="w-full max-w-2xl">
          <h2 className="mb-4 font-arcade text-xs text-arcade-yellow">캐릭터 스타일을 선택하세요</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {CHARACTER_STYLES.map((style) => (
              <button
                key={style.id}
                onClick={() => setSelectedId(style.id)}
                className={`rounded border-2 p-4 text-left transition ${
                  selectedId === style.id
                    ? "border-arcade-neon bg-arcade-panel shadow-neon"
                    : "border-white/20 bg-arcade-panel/50 hover:border-arcade-cyan"
                }`}
              >
                <p className="font-arcade text-[11px] text-white">{style.nameKo}</p>
                <p className="mt-2 text-xs text-gray-400">{style.description}</p>
                <p className="mt-2 text-[10px] text-arcade-cyan">필살기: {style.signatureMove.nameKo}</p>
              </button>
            ))}
          </div>
          <button
            onClick={handleStartNew}
            className="mt-6 w-full rounded border-2 border-arcade-neon bg-arcade-panel py-3 font-arcade text-xs text-arcade-neon shadow-neon hover:bg-arcade-neon hover:text-black"
          >
            이 캐릭터로 시작하기
          </button>
        </div>
      )}
    </div>
  );
}
