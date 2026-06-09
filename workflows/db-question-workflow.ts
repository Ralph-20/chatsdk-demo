import { getWorkflowMetadata } from "workflow";
import { queryInSandboxStep } from "./steps/query-in-sandbox";
import { postSlackStep } from "./steps/post-slack";
import { startRunStep, finishRunStep } from "./steps/record-run";

export interface DbQuestionWorkflowInput {
  question: string;
  reply: { platform: "slack"; channel: string; threadTs: string };
}

/**
 * Durable "talk to your DB" pipeline: answer a natural-language question by
 * running SELECT-only queries inside an ephemeral sandbox (where the DB
 * credential lives, never the Fluid function's other secrets) → post the prose
 * answer back into the Slack thread. Wrapped in try/catch so a failure posts a
 * graceful note instead of going silent. Step state is captured to Postgres
 * for the visualization page; WDK Observability covers timings.
 */
export async function dbQuestionWorkflow(input: DbQuestionWorkflowInput): Promise<void> {
  "use workflow";
  const runId = getWorkflowMetadata().workflowRunId;
  const meta = { kind: "db-question", question: input.question.slice(0, 500) };

  await startRunStep({ runId, meta });

  try {
    const { answer } = await queryInSandboxStep({ runId, question: input.question });
    await postSlackStep({
      runId,
      channel: input.reply.channel,
      threadTs: input.reply.threadTs,
      body: answer,
      label: "postDbAnswer",
    });
    await finishRunStep({ runId, meta, status: "completed" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishRunStep({ runId, meta, status: "failed", error: message });
    await postSlackStep({
      runId,
      channel: input.reply.channel,
      threadTs: input.reply.threadTs,
      body: "🤖 I tried to query the demo DB but hit a problem and couldn't finish.",
      label: "postDbFailure",
    }).catch(() => {});
    throw err;
  }
}
