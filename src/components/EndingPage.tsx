"use client";

import { downloadEndingCard } from "@/lib/shareCard";
import { Ending, PlayerStats } from "@/types/game";

interface EndingPageProps {
  ending: Ending;
  stats: PlayerStats;
  onRestart: () => void;
}

export default function EndingPage({ ending, stats, onRestart }: EndingPageProps) {
  return (
    <div className="mx-auto flex min-h-screen max-w-xl flex-col items-center justify-center gap-6 bg-arcade-bg px-6 py-10 text-center">
      <h1 className="font-arcade text-sm text-arcade-yellow">엔딩</h1>
      <h2 className="font-arcade text-lg text-arcade-neon">{ending.nameKo}</h2>
      <p className="whitespace-pre-line text-sm leading-relaxed text-gray-200">{ending.text}</p>

      <div className="w-full rounded border border-white/20 bg-black/40 p-4 text-left text-xs text-gray-300">
        <p>총 {stats.total_wins}승 {stats.total_losses}패</p>
        <p>명성 {stats.fame} · 첫사랑 호감도 {stats.love} · 가족 관계 {stats.family}</p>
        <p>졸업 시점 소지금 {stats.money.toLocaleString()}원</p>
      </div>

      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          onClick={() => downloadEndingCard(ending, stats)}
          className="rounded border-2 border-arcade-yellow bg-arcade-panel px-6 py-3 font-arcade text-xs text-arcade-yellow hover:bg-arcade-yellow hover:text-black"
        >
          엔딩 카드 저장 (공유용)
        </button>
        <button
          onClick={onRestart}
          className="rounded border-2 border-arcade-neon bg-arcade-panel px-6 py-3 font-arcade text-xs text-arcade-neon shadow-neon hover:bg-arcade-neon hover:text-black"
        >
          새로운 이야기 시작하기
        </button>
      </div>
    </div>
  );
}
