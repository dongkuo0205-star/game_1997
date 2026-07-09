interface ArcadeHeaderProps {
  day: number;
  money: number;
}

function dayToDate(day: number): string {
  // Day 1 = 1997-09-01, roughly one in-game "day" per arcade visit.
  const start = new Date(1997, 8, 1);
  start.setDate(start.getDate() + (day - 1));
  const y = start.getFullYear();
  const m = start.getMonth() + 1;
  const d = start.getDate();
  return `${y}년 ${m}월 ${d}일`;
}

export default function ArcadeHeader({ day, money }: ArcadeHeaderProps) {
  return (
    <header className="flex items-center justify-between border-b-2 border-arcade-neon/60 bg-arcade-panel px-4 py-3 shadow-neon">
      <div>
        <h1 className="font-arcade text-sm text-arcade-neon sm:text-base">오락실 1997</h1>
        <p className="mt-1 text-xs text-arcade-cyan">{dayToDate(day)} · {day}일째</p>
      </div>
      <div className="rounded border border-arcade-yellow/60 bg-black/40 px-3 py-2 text-right">
        <p className="text-[10px] text-arcade-yellow">지갑</p>
        <p className="font-arcade text-xs text-arcade-yellow">{money.toLocaleString()}원</p>
      </div>
    </header>
  );
}
