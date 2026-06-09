import { recordRun } from "@/lib/pipeline/record";

/**
 * Run-level lifecycle records. These wrap `recordRun` in `"use step"` so the
 * deterministic workflow body never performs Node I/O directly.
 */

export async function startRunStep(input: {
  runId: string;
  meta: Record<string, unknown>;
}): Promise<void> {
  "use step";
  await recordRun(input.runId, { ...input.meta, status: "running" });
}

export async function finishRunStep(input: {
  runId: string;
  meta: Record<string, unknown>;
  status: "completed" | "failed";
  error?: string;
}): Promise<void> {
  "use step";
  await recordRun(input.runId, {
    ...input.meta,
    status: input.status,
    ...(input.error ? { error: input.error } : {}),
  });
}
