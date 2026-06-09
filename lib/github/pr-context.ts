import type { GitHubRawMessage } from "@chat-adapter/github";

/**
 * Whether a GitHub message belongs to a pull request (vs a plain issue).
 * PR threads route to the durable sandbox review; issues fall through to the
 * helpful agent. The old Octokit prefetch was replaced by `prReviewWorkflow`.
 */
export function isPrThread(raw: GitHubRawMessage): boolean {
  if (raw.type === "review_comment") return true;
  return raw.threadType !== "issue";
}
