import { BattleState } from "@/types/game";

function HpBar({ hp, colorClass, align }: { hp: number; colorClass: string; align: "left" | "right" }) {
  const pct = Math.max(0, Math.min(100, hp));
  return (
    <div className="h-4 w-full overflow-hidden rounded border border-white/30 bg-black/60">
      <div
        className={`h-full ${colorClass} transition-all duration-300`}
        style={{
          width: `${pct}%`,
          marginLeft: align === "right" ? `${100 - pct}%` : undefined,
        }}
      />
    </div>
  );
}

const DISTANCE_LABEL: Record<BattleState["distance"], string> = {
  close: "근거리",
  mid: "중거리",
  far: "원거리",
};

const MOMENTUM_LABEL: Record<BattleState["momentum"], string> = {
  player: "당신 우세",
  opponent: "상대 우세",
  neutral: "팽팽함",
};

export default function BattlePanel({ battle }: { battle: BattleState }) {
  return (
    <div className="rounded border border-arcade-yellow/50 bg-black/40 p-3">
      <div className="mb-2 flex items-center justify-between text-[10px] text-arcade-yellow">
        <span>ROUND {battle.roundNumber} / 3</span>
        <span>
          {battle.playerRoundsWon} : {battle.opponentRoundsWon}
        </span>
      </div>

      <div className="mb-1 flex justify-between text-[10px] text-white">
        <span>나 {battle.playerHp}</span>
        <span>{battle.opponent.name} {battle.opponentHp}</span>
      </div>
      <HpBar hp={battle.playerHp} colorClass="bg-arcade-green" align="left" />
      <div className="mt-1">
        <HpBar hp={battle.opponentHp} colorClass="bg-arcade-red" align="right" />
      </div>

      <div className="mt-2 flex justify-between text-[10px] text-gray-300">
        <span>기력 {battle.playerMeter}</span>
        <span>기력 {battle.opponentMeter}</span>
      </div>

      <div className="mt-3 flex justify-between text-[11px] text-arcade-cyan">
        <span>거리: {DISTANCE_LABEL[battle.distance]}</span>
        <span>기세: {MOMENTUM_LABEL[battle.momentum]}</span>
      </div>
    </div>
  );
}
