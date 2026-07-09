import { Opponent } from "@/types/game";

export default function OpponentCard({ opponent }: { opponent: Opponent }) {
  return (
    <div className="rounded border border-arcade-red/50 bg-arcade-panel/80 p-3">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="font-arcade text-[11px] text-arcade-red">오늘의 상대</h2>
        <span className="text-[10px] text-arcade-yellow">{"★".repeat(opponent.difficulty)}</span>
      </div>
      <p className="text-sm font-bold text-white">
        {opponent.name} <span className="text-xs text-gray-400">({opponent.age}세)</span>
      </p>
      <p className="text-xs text-gray-400">{opponent.schoolOrJob}</p>
      <p className="mt-2 text-xs text-gray-300">{opponent.personality}</p>
      <p className="text-xs text-gray-300">{opponent.battleStyle}</p>
      <p className="mt-2 border-t border-white/10 pt-2 text-xs italic text-arcade-cyan">
        &ldquo;{opponent.dialogueStyle}&rdquo;
      </p>
    </div>
  );
}
