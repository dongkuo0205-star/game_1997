import { useEffect, useRef } from "react";
import { StoryLogEntry } from "@/types/game";

const KIND_STYLE: Record<StoryLogEntry["kind"], string> = {
  story: "text-gray-100",
  battle: "text-gray-100",
  system: "text-arcade-cyan text-xs italic",
  ending: "text-arcade-yellow",
};

export default function StoryLog({ entries }: { entries: StoryLogEntry[] }) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [entries.length]);

  return (
    <div className="h-64 overflow-y-auto rounded border border-white/10 bg-black/60 p-3 sm:h-80">
      {entries.length === 0 && (
        <p className="text-xs text-gray-500">오락실 문을 열고 들어선다...</p>
      )}
      {entries.map((entry) => (
        <p key={entry.id} className={`mb-3 whitespace-pre-line text-sm leading-relaxed ${KIND_STYLE[entry.kind]}`}>
          {entry.text}
        </p>
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
