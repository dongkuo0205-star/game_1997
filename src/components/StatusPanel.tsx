import { PlayerStats } from "@/types/game";

interface StatBarProps {
  label: string;
  value: number;
  max?: number;
  colorClass: string;
}

function StatBar({ label, value, max = 100, colorClass }: StatBarProps) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="mb-2">
      <div className="mb-0.5 flex justify-between text-[10px] text-gray-300">
        <span>{label}</span>
        <span>{value}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded bg-black/50">
        <div className={`h-full ${colorClass}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export default function StatusPanel({ stats }: { stats: PlayerStats }) {
  return (
    <div className="rounded border border-arcade-cyan/40 bg-arcade-panel/80 p-3">
      <h2 className="mb-2 font-arcade text-[11px] text-arcade-cyan">내 상태</h2>
      <StatBar label="실력" value={stats.skill} colorClass="bg-arcade-red" />
      <StatBar label="정신력" value={stats.mind} colorClass="bg-arcade-cyan" />
      <StatBar label="반사신경" value={stats.reaction} colorClass="bg-arcade-yellow" />
      <StatBar label="연속기" value={stats.combo} colorClass="bg-arcade-green" />
      <StatBar label="명성" value={stats.fame} colorClass="bg-arcade-neon" />
      <StatBar label="체력(컨디션)" value={stats.stamina} colorClass="bg-arcade-green" />
      <StatBar label="첫사랑 호감도" value={stats.love} colorClass="bg-pink-400" />
      <StatBar label="가족 관계" value={stats.family} colorClass="bg-orange-400" />
      <div className="mt-2 flex justify-between text-[10px] text-gray-300">
        <span>연승 {stats.win_streak}</span>
        <span>
          {stats.total_wins}승 {stats.total_losses}패
        </span>
      </div>
    </div>
  );
}
