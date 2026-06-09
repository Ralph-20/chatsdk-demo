import { generateText, type ImagePart, type TextPart } from "ai";
import { recordStep } from "@/lib/pipeline/record";
import { agents } from "@/lib/agents";
import type { Shot } from "./review-in-sandbox";

const MODEL = "anthropic/claude-opus-4-7";

export interface VisionReviewInput {
  runId: string;
  /** The static, code-grounded review from the sandbox step. */
  staticReview: string;
  /** `git diff --stat` summary for context. */
  diffSummary: string;
  /** Screenshots of the running app (Blob URLs). */
  shots: Shot[];
  /** Whether the app actually booted; gates the visual critique. */
  ranOk: boolean;
  /** Notes from the runtime lane (e.g. why it degraded). */
  notes: string[];
}

export interface VisionReviewOutput {
  review: string;
}

/**
 * Second pass: feed the static review + the live-app screenshots back to Opus
 * (multimodal) so the final review *describes what it saw* — grounding the prose
 * in runtime behavior, not just source text. When the runtime lane didn't run,
 * passes the static review through unchanged (plus a one-line note).
 */
export async function visionReviewStep(input: VisionReviewInput): Promise<VisionReviewOutput> {
  "use step";
  const { runId, staticReview, diffSummary, shots, ranOk, notes } = input;

  // No live run → nothing visual to add. Return static review with the note.
  if (!ranOk || shots.length === 0) {
    await recordStep(runId, "visionReview", "skipped", { ranOk, shots: shots.length });
    const note = notes[0] ? `\n\n_${notes[0]}_` : "";
    return { review: staticReview + note };
  }

  await recordStep(runId, "visionReview", "running", { shots: shots.length });

  const imageParts: ImagePart[] = shots.map((s) => ({
    type: "image",
    image: new URL(s.url),
  }));
  const labels = shots.map((s, i) => `Screenshot ${i + 1}: ${s.label}`).join("\n");

  const intro: TextPart = {
    type: "text",
    text: [
      "Here is your earlier code-only review of this PR:",
      "",
      staticReview,
      "",
      "Diff stat:",
      diffSummary || "(none)",
      "",
      "I booted the app and exercised it in a browser. Attached are the screenshots:",
      labels,
      "",
      "Now produce the FINAL review. Revise your prose so it is grounded in what the screenshots " +
        "actually show — confirm the change renders/behaves as intended, and call out any visual or " +
        "runtime issues you can see (layout breakage, error states, missing UI, console-y symptoms). " +
        "Keep it concise GitHub-flavored markdown. Do NOT embed the images yourself — they'll be " +
        "appended below your review in a gallery.",
    ].join("\n"),
  };

  const result = await generateText({
    model: MODEL,
    system: agents.prReviewer.systemPrompt,
    messages: [{ role: "user", content: [intro, ...imageParts] }],
  });

  await recordStep(runId, "visionReview", "completed", { length: result.text.length });
  return { review: result.text };
}

visionReviewStep.maxRetries = 1;
