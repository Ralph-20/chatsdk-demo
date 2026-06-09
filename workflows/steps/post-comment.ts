import { Octokit } from "@octokit/rest";
import { recordStep } from "@/lib/pipeline/record";
import { mintInstallationToken } from "@/lib/github/app-auth";
import type { Shot } from "./review-in-sandbox";

/**
 * Post the review back to the PR. Mints its own short-lived token (so the secret
 * never crosses a step boundary into the durable event log) and uses a plain
 * Octokit because the adapter's post path is AsyncLocalStorage-bound.
 *
 * When `shots` are provided, appends a "## What I saw" gallery of the live-app
 * screenshots so the comment shows the bot actually ran the change.
 */
export async function postCommentStep(input: {
  runId: string;
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
  /** label distinguishes the review comment from the failure note in records */
  label?: string;
  /** screenshots of the running app to embed below the review */
  shots?: Shot[];
}): Promise<void> {
  "use step";
  const { runId, installationId, owner, repo, prNumber, body, label = "postComment", shots = [] } = input;
  const token = await mintInstallationToken(installationId);
  const fullBody = body + gallery(shots);
  await new Octokit({ auth: token }).rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body: fullBody,
  });
  await recordStep(runId, label, "completed", { shots: shots.length });
}

/** Render the screenshot gallery markdown appended below the review. */
function gallery(shots: Shot[]): string {
  if (shots.length === 0) return "";
  const blocks = shots
    .map((s) => `**${s.label}**\n\n![${s.label}](${s.url})`)
    .join("\n\n");
  const count = shots.length === 1 ? "1 screenshot" : `${shots.length} screenshots`;
  return [
    "",
    "",
    "## What I saw",
    "",
    blocks,
    "",
    `_Booted the app and exercised it in a headless browser. ${count}._`,
  ].join("\n");
}
