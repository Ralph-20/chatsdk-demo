import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

/**
 * App-auth helpers for use *outside* the webhook AsyncLocalStorage (e.g. in
 * durable workflow steps), where the GitHub adapter's own `octokit` getter
 * throws. Mirrors how the adapter builds its installation client.
 */
function appCredentials(): { appId: string; privateKey: string } {
  const appId = process.env.GITHUB_APP_ID;
  const privateKey = process.env.GITHUB_PRIVATE_KEY;
  if (!appId || !privateKey) {
    throw new Error("GITHUB_APP_ID / GITHUB_PRIVATE_KEY not configured");
  }
  return { appId, privateKey };
}

/** An installation-scoped Octokit authenticated via the GitHub App. */
export function appOctokit(installationId: number): Octokit {
  const { appId, privateKey } = appCredentials();
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey, installationId },
  });
}

/**
 * Resolve the installation id for a repo from owner/repo alone (no thread).
 * Used by the Slack trigger, where the message carries no GitHub installation
 * context. Returns null when the App isn't installed on the repo — which is the
 * trust gate: we only review repos the App was explicitly added to.
 */
export async function resolveInstallationId(
  owner: string,
  repo: string,
): Promise<number | null> {
  const { appId, privateKey } = appCredentials();
  // App-level (JWT) auth — no installationId yet; that's what we're resolving.
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey },
  });
  try {
    const { data } = await octokit.rest.apps.getRepoInstallation({ owner, repo });
    return data.id;
  } catch {
    return null;
  }
}

/**
 * Mint a short-lived installation access token (contents:read) for cloning the
 * PR repo into a sandbox. Minted fresh per step so it never lands in the
 * durable workflow event log.
 */
export async function mintInstallationToken(installationId: number): Promise<string> {
  const octokit = appOctokit(installationId);
  const { data } = await octokit.rest.apps.createInstallationAccessToken({
    installation_id: installationId,
    // contents:read — clone the PR into the sandbox.
    // pull_requests:write / issues:write — post the review back (PR comments go
    // through the issues API; GitHub accepts either permission).
    permissions: {
      contents: "read",
      pull_requests: "write",
      issues: "write",
    },
  });
  return data.token;
}
