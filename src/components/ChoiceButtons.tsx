import { getAction } from "@/data/actions";
import { Choice } from "@/types/game";

interface ChoiceButtonsProps {
  choices: Choice[];
  onChoose: (choice: Choice) => void;
  disabled: boolean;
}

export default function ChoiceButtons({ choices, onChoose, disabled }: ChoiceButtonsProps) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {choices.map((choice) => {
        const def = getAction(choice.actionId);
        return (
          <button
            key={choice.id}
            disabled={disabled}
            onClick={() => onChoose(choice)}
            className="group flex flex-col items-start rounded border-2 border-arcade-cyan/60 bg-arcade-panel px-3 py-2 text-left transition hover:border-arcade-neon hover:shadow-neon disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span className="font-arcade text-[10px] text-arcade-yellow">{choice.id}</span>
            <span className="mt-1 text-sm font-bold text-white">{choice.text}</span>
            <span className="mt-1 text-[10px] text-gray-400">{def.flavorKo}</span>
          </button>
        );
      })}
    </div>
  );
}
