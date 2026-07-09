import { Choice } from "@/types/game";
import { DEVELOPER_PROMPT, NarratorContext, SYSTEM_PROMPT, buildUserPrompt } from "@/lib/prompts";
import { mockNarrateExchange, mockNarrateMatchStart } from "@/lib/mockAI";

const CLAUDE_MODEL = "claude-sonnet-5";
const CLAUDE_API_URL = "https://api.anthropic.com/v1/messages";

interface NarratorOutput {
  story: string;
  choices: Choice[];
}

function isRealApiAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

function coerceChoices(raw: unknown, candidateActionIds: NarratorContext["candidateActionIds"]): Choice[] {
  const ids: Array<"A" | "B" | "C"> = ["A", "B", "C"];
  if (!Array.isArray(raw)) {
    throw new Error("choices is not an array");
  }
  return ids.map((id, i) => {
    const entry = raw[i] as { text?: unknown } | undefined;
    const text = typeof entry?.text === "string" && entry.text.trim().length > 0 ? entry.text.trim() : undefined;
    const actionId = candidateActionIds[i];
    if (!actionId) throw new Error("missing candidate action id");
    return { id, text: text ?? actionId, actionId };
  });
}

async function callClaude(ctx: NarratorContext): Promise<NarratorOutput> {
  const res = await fetch(CLAUDE_API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY as string,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 700,
      system: `${SYSTEM_PROMPT}\n\n${DEVELOPER_PROMPT}`,
      messages: [{ role: "user", content: buildUserPrompt(ctx) }],
    }),
  });

  if (!res.ok) {
    throw new Error(`Claude API error: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const text: string = data?.content?.[0]?.text ?? "";
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Claude response did not contain JSON");
  const parsed = JSON.parse(jsonMatch[0]);

  if (typeof parsed.story !== "string" || !parsed.story.trim()) {
    throw new Error("Claude response missing story");
  }

  return {
    story: parsed.story.trim(),
    choices: coerceChoices(parsed.choices, ctx.candidateActionIds),
  };
}

export async function narrateMatchStart(ctx: NarratorContext): Promise<NarratorOutput> {
  if (!isRealApiAvailable()) return mockNarrateMatchStart(ctx);
  try {
    return await callClaude(ctx);
  } catch {
    return mockNarrateMatchStart(ctx);
  }
}

export async function narrateExchange(ctx: NarratorContext): Promise<NarratorOutput> {
  if (!isRealApiAvailable()) return mockNarrateExchange(ctx);
  try {
    return await callClaude(ctx);
  } catch {
    return mockNarrateExchange(ctx);
  }
}
