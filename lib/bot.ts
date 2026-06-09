import { Chat, emoji, NotImplementedError, type Adapter } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createGitHubAdapter, type GitHubRawMessage, type GitHubAdapter } from "@chat-adapter/github";
import { createLinearAdapter } from "@chat-adapter/linear";
import { createPostgresState } from "@chat-adapter/state-pg";
import { ToolLoopAgent } from "ai";
import { toAiMessages } from "chat/ai";
import { start } from "workflow/api";
import { agents } from "./agents";
import { isPrThread } from "./github/pr-context";
import { resolveInstallationId } from "./github/app-auth";
import { hasRunningReview } from "./pipeline/record";
import { prReviewWorkflow } from "@/workflows/pr-review-workflow";
import { dbQuestionWorkflow } from "@/workflows/db-question-workflow";
import { classifyIntent } from "./intent";

// GitHub comment author_association values we trust to trigger a sandbox review.
// Gates the abuse surface: arbitrary external commenters can't make us clone,
// install, and run code on our infra — only repo collaborators/members/owners.
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

const PR_URL_RE = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i;

const MODEL = "anthropic/claude-opus-4-7";

const helpfulAgent = new ToolLoopAgent({
  model: MODEL,
  instructions: agents.helpful.systemPrompt,
});

// Lazily construct the bot on first use. Adapter factories validate their env
// (e.g. SLACK_SIGNING_SECRET) eagerly and throw when it's missing — doing that
// at module-import time breaks `next build`'s page-data collection, which
// imports route modules without runtime secrets. Deferring to first request
// keeps the build deterministic and secret-free.
let _bot: ReturnType<typeof buildBot> | undefined;

export function getBot() {
  return (_bot ??= buildBot());
}

function buildBot() {
  const adapters: Record<string, Adapter> = {
    slack: createSlackAdapter(),
    github: createGitHubAdapter({
      appId: process.env.GITHUB_APP_ID!,
      privateKey: process.env.GITHUB_PRIVATE_KEY!,
    }),
  };

  if (process.env.LINEAR_API_KEY && process.env.LINEAR_WEBHOOK_SECRET) {
    adapters.linear = createLinearAdapter();
  }

  const bot = new Chat({
    userName: "bob-the-bot",
    adapters,
    state: createPostgresState(),
    onLockConflict: "force",
  }).registerSingleton();

  bot.onNewMention(async (thread, message) => {
    await thread.subscribe();
    await react(thread, message);
    await typing(thread);
    if (isGitHubPr(bot, thread, message)) {
      await startPrReview(bot, thread, message);
      return;
    }
    if (await maybeStartSlackPrReview(bot, thread, message)) return;
    if (await maybeStartDbQuestion(bot, thread, message)) return;
    if (await maybeRouteByIntent(bot, thread, message)) return;
    const res = await helpfulAgent.stream({ prompt: message.text });
    await thread.post(res.fullStream);
  });

  bot.onSubscribedMessage(async (thread, message) => {
    await react(thread, message);
    await typing(thread);
    if (isGitHubPr(bot, thread, message)) {
      await startPrReview(bot, thread, message);
      return;
    }
    if (await maybeStartSlackPrReview(bot, thread, message)) return;
    if (await maybeStartDbQuestion(bot, thread, message)) return;
    if (await maybeRouteByIntent(bot, thread, message)) return;
    const { messages } = await thread.adapter.fetchMessages(thread.id, { limit: 20 });
    const res = await helpfulAgent.stream({ prompt: await toAiMessages(messages) });
    await thread.post(res.fullStream);
  });

  return bot;
}

type Bot = ReturnType<typeof buildBot>;
type Thread = Parameters<Parameters<Bot["onNewMention"]>[0]>[0];
type Message = Parameters<Parameters<Bot["onNewMention"]>[0]>[1];

async function react(thread: Thread, message: Message) {
  try { await thread.createSentMessageFromMessage(message).addReaction(emoji.eyes); } catch (e) { if (!(e instanceof NotImplementedError)) throw e; }
}

async function typing(thread: Thread) {
  try { await thread.startTyping(); } catch (e) { if (!(e instanceof NotImplementedError)) throw e; }
}

function isGitHubPr(bot: Bot, thread: Thread, message: Message): boolean {
  if (thread.adapter !== bot.getAdapter("github")) return false;
  return isPrThread(message.raw as GitHubRawMessage);
}

// Kick off the durable, sandbox-backed PR review from a GitHub @-mention.
// Resolves the installation ID here (where the adapter is live inside the
// webhook ALS) and hands the work to `prReviewWorkflow`. Returns immediately.
async function startPrReview(bot: Bot, thread: Thread, message: Message) {
  const raw = message.raw as GitHubRawMessage;

  // Trust gate: only repo collaborators/members/owners can trigger a run.
  // `author_association` is on the webhook payload (not in the adapter's type).
  const assoc = (raw.comment as { author_association?: string }).author_association;
  if (!TRUSTED_ASSOCIATIONS.has(assoc ?? "")) {
    await thread.post(
      "🤖 Only repo collaborators can ask me to review a PR. (You can still @-mention me with questions.)",
    );
    return;
  }

  const ghAdapter = bot.getAdapter("github") as GitHubAdapter;
  const installationId = await ghAdapter.getInstallationId(thread.id);
  if (!installationId) {
    await thread.post(
      "🤖 I couldn't find a GitHub App installation for this repo, so I can't review it.",
    );
    return;
  }

  const owner = raw.repository.owner.login;
  const repo = raw.repository.name;
  if (await hasRunningReview(owner, repo, raw.prNumber)) {
    await thread.post("🤖 I'm already reviewing this PR — hang tight.");
    return;
  }

  await start(prReviewWorkflow, [
    { installationId, owner, repo, prNumber: raw.prNumber, userText: message.text },
  ]);
}

// Minimal shape of the Slack event we read off `message.raw` (the adapter types
// it as `unknown`). We only need the channel + thread anchoring fields.
type SlackRaw = { channel?: string; thread_ts?: string; ts?: string };

/**
 * Slack trigger: if a message pastes a GitHub PR URL, run the same durable
 * review and post the result back into the Slack thread. Returns true when it
 * handled the message (so the caller skips the generic chat reply).
 *
 * Trust gate for the public-repo case: we only review repos where our GitHub
 * App is installed (installationId resolves). Unknown repos are declined.
 */
async function maybeStartSlackPrReview(bot: Bot, thread: Thread, message: Message): Promise<boolean> {
  if (thread.adapter !== bot.getAdapter("slack")) return false;
  const m = (message.text ?? "").match(PR_URL_RE);
  if (!m) return false;

  const [, owner, repo, prStr] = m;
  const prNumber = Number(prStr);

  const installationId = await resolveInstallationId(owner, repo);
  if (!installationId) {
    await thread.post(
      `🤖 I can't review \`${owner}/${repo}\` — my GitHub App isn't installed on it.`,
    );
    return true;
  }

  if (await hasRunningReview(owner, repo, prNumber)) {
    await thread.post(`🤖 I'm already reviewing ${owner}/${repo}#${prNumber} — hang tight.`);
    return true;
  }

  const raw = message.raw as SlackRaw;
  const channel = raw.channel;
  const threadTs = raw.thread_ts ?? raw.ts;
  if (!channel || !threadTs) return false; // can't anchor a reply; fall through

  await start(prReviewWorkflow, [
    {
      installationId,
      owner,
      repo,
      prNumber,
      userText: message.text,
      reply: { platform: "slack", channel, threadTs },
    },
  ]);
  await thread.post(`🤖 On it — reviewing ${owner}/${repo}#${prNumber}. I'll post back here.`);
  return true;
}

// `[\s\S]+` (not `.+` with the `s` flag) so a multi-line question is captured
// without requiring an es2018 regex target.
const DB_QUESTION_RE = /^\s*(?:ask\s+)?db:\s*([\s\S]+)/i;

/**
 * Slack trigger: a `db: <question>` message kicks off the durable "talk to your
 * DB" workflow — a sandbox queries the demo e-commerce DB and posts a prose
 * answer back in-thread. Returns true when it handled the message (so the caller
 * skips the generic chat reply).
 */
async function maybeStartDbQuestion(bot: Bot, thread: Thread, message: Message): Promise<boolean> {
  if (thread.adapter !== bot.getAdapter("slack")) return false;
  // The mention is NOT stripped from message.text (it arrives as
  // `<@U123> db: …`), so drop any leading mention tokens before anchoring.
  const text = (message.text ?? "").replace(/^\s*(?:<@[^>]+>\s*)+/, "");
  const m = text.match(DB_QUESTION_RE);
  if (!m) return false;
  const question = m[1].trim();
  if (!question) return false;

  const raw = message.raw as SlackRaw;
  const channel = raw.channel;
  const threadTs = raw.thread_ts ?? raw.ts;
  if (!channel || !threadTs) return false; // can't anchor a reply; fall through

  await start(dbQuestionWorkflow, [
    { question, reply: { platform: "slack", channel, threadTs } },
  ]);
  await thread.post("🤖 On it — querying the demo DB…");
  return true;
}

/**
 * LLM fallback router: for a free-form Slack message that hit none of the
 * keyword fast-paths, classify intent and route. Today that means "natural
 * language DB questions" (no `db:` prefix needed); other intents fall through
 * to the generic chat reply. Returns true when it kicked off a workflow.
 */
async function maybeRouteByIntent(bot: Bot, thread: Thread, message: Message): Promise<boolean> {
  if (thread.adapter !== bot.getAdapter("slack")) return false;

  const text = (message.text ?? "").replace(/^\s*(?:<@[^>]+>\s*)+/, "").trim();

  const intent = await classifyIntent(text);
  if (intent.intent !== "db_question") return false;

  const raw = message.raw as SlackRaw;
  const channel = raw.channel;
  const threadTs = raw.thread_ts ?? raw.ts;
  if (!channel || !threadTs) return false;

  await start(dbQuestionWorkflow, [
    {
      question: intent.question?.trim() || text,
      reply: { platform: "slack", channel, threadTs },
    },
  ]);
  await thread.post("🤖 On it — querying the demo DB…");
  return true;
}
