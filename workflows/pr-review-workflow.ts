import { getWorkflowMetadata } from "workflow";
import { reviewInSandboxStep } from "./steps/review-in-sandbox";
import { visionReviewStep } from "./steps/vision-review";
import { postCommentStep } from "./steps/post-comment";
import { postSlackStep } from "./steps/post-slack";
import { startRunStep, finishRunStep } from "./steps/record-run";

/** Where the finished review is delivered. */
export type ReplyTarget =
  | { platform: "github" }
  | { platform: "slack"; channel: string; threadTs: string };

export interface PrReviewWorkflowInput {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  userText: string;
  /** Defaults to GitHub (the @-mention path). Slack carries channel + thread. */
  reply?: ReplyTarget;
}

/**
 * Durable PR-review pipeline: clone + review the PR in an ephemeral sandbox
 * (minting its own token per step) → vision pass over live-app screenshots →
 * post the review back to GitHub or Slack. Wrapped in try/catch so a failure
 * posts a graceful note instead of going silent. Step state is captured to
 * Postgres for the future visualization page; WDK Observability covers timings.
 */
export async function prReviewWorkflow(input: PrReviewWorkflowInput): Promise<void> {
  "use workflow";
  const { installationId, owner, repo, prNumber, userText, reply = { platform: "github" } } = input;
  const runId = getWorkflowMetadata().workflowRunId;
  const meta = { owner, repo, prNumber, replyPlatform: reply.platform };

  await startRunStep({ runId, meta });

  try {
    const { review, shots, ranOk, notes, diffSummary } = await reviewInSandboxStep({
      runId,
      installationId,
      owner,
      repo,
      prNumber,
      userText,
    });
    const { review: finalReview } = await visionReviewStep({
      runId,
      staticReview: review,
      diffSummary,
      shots,
      ranOk,
      notes,
    });
    await deliver(reply, { runId, installationId, owner, repo, prNumber, body: finalReview, shots });
    await finishRunStep({ runId, meta, status: "completed" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finishRunStep({ runId, meta, status: "failed", error: message });
    await deliver(reply, {
      runId,
      installationId,
      owner,
      repo,
      prNumber,
      label: "postFailureNote",
      body:
        "🤖 I started reviewing this PR but hit a problem and couldn't finish. " +
        "I'll need another nudge once it's sorted.",
    }).catch(() => {});
    throw err;
  }
}

/** Route the review to the right platform. */
async function deliver(
  reply: ReplyTarget,
  args: {
    runId: string;
    installationId: number;
    owner: string;
    repo: string;
    prNumber: number;
    body: string;
    shots?: { label: string; url: string }[];
    label?: string;
  },
): Promise<void> {
  if (reply.platform === "slack") {
    await postSlackStep({
      runId: args.runId,
      channel: reply.channel,
      threadTs: reply.threadTs,
      body: args.body,
      shots: args.shots,
      label: args.label,
    });
    return;
  }
  await postCommentStep(args);
}
