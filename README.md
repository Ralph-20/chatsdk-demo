# chatsdk-demo

One bot — `bob-the-bot` — reachable from **Slack**, **GitHub**, and (optionally) **Linear** through a single webhook handler. Built on **Next.js 16** + [**chat-sdk**](https://chat-sdk.dev), with durable [Vercel Workflow](https://vercel.com/docs/workflow) pipelines and ephemeral [Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) execution.

> **Hero moment:** the same `onNewMention` / `onSubscribedMessage` handlers respond on every platform with zero platform-specific code in the handler. Adapters normalize the rest.

## What it does

| Trigger | What happens |
| --- | --- |
| @-mention or in-thread reply (any platform) | Streams an AI reply via an AI SDK `ToolLoopAgent` (Claude Opus via [Vercel AI Gateway](https://vercel.com/docs/ai-gateway)). Multi-turn — the bot subscribes to the thread and keeps context. |
| @-mention on a GitHub PR, **or** paste a PR URL in Slack | Kicks off a **durable PR-review workflow**: clones + reviews the PR in an ephemeral sandbox, runs a vision pass over live-app screenshots, and posts the review back to GitHub or the Slack thread. Trust-gated to repo collaborators/members/owners. |
| Slack `db: <question>` — or a plain natural-language question | Routes (keyword fast-path, else LLM intent classifier) to a **durable "talk to your DB" workflow**: runs SELECT-only queries in a sandbox against a demo e-commerce Postgres DB and posts a prose answer in-thread. |

All long-running work runs as durable [Workflow DevKit](https://vercel.com/docs/workflow) pipelines (survives restarts, observable, step state recorded to Postgres). Secrets that the sandbox needs (DB credential, GitHub token) are minted per-step inside the sandbox, never exposed to the rest of the function.

## Request flow

A message lands on one webhook and is dispatched through a single routing chain
(`lib/bot.ts`). The first matching rule wins; everything else falls through to a
plain chat reply. Routing happens in the **webhook function** — durable workflows
only start *after* a route is chosen.

```
@-mention / thread reply (Slack · GitHub · Linear)
        │
        ▼
POST /api/webhooks/[platform]            app/api/webhooks/[platform]/route.ts
        │  getBot() → bot.webhooks[platform]   (verify signature, parse event)
        ▼
onNewMention / onSubscribedMessage       lib/bot.ts
        │
        ▼
┌─ routing chain (first match wins) ──────────────────────────────┐
│ 1. isGitHubPr()            PR thread?        ─► PR-review workflow │
│ 2. maybeStartSlackPrReview() PR URL pasted?  ─► PR-review workflow │
│ 3. maybeStartDbQuestion()  "db:" prefix?     ─► DB-question workflow│
│ 4. maybeRouteByIntent()    LLM classifier ───┐                     │
│ 5. else                                      │  ─► chat reply       │
└──────────────────────────────────────────────┼────────────────────┘
                                                ▼
                              classifyIntent()  lib/intent.ts
                              Haiku 4.5 · temp 0 · structured output
                              { reasoning, intent, confidence, question }
                              confidence < 0.6  ─► downgrade to chat
                              logs:  [intent] db_question@0.92; reasoning: …
                                                │
                          intent = db_question? │
                                ┌───────────────┴───────────────┐
                                │ yes                            │ no
                                ▼                                ▼
                  start(dbQuestionWorkflow)              helpfulAgent (chat)
                  workflows/db-question-workflow.ts
                                │
                                ▼
        ┌─ durable steps (Workflow dashboard) ───────────────────┐
        │ generate SELECT  →  query-in-sandbox  →  post answer    │
        │  (LLM → SQL)        (ephemeral VM)       (back to thread)│
        └─────────────────────────────────────────────────────────┘
```

**Example — "how many orders shipped this week?"** (no `db:` prefix, no PR URL):
rules 1–3 miss → `maybeRouteByIntent()` → `classifyIntent()` returns
`db_question@0.92` → `start(dbQuestionWorkflow)` posts *"On it — querying the demo
DB…"*, the sandbox runs the SELECT, and the prose answer is posted in-thread. The
`[intent]` decision shows in **Runtime Logs** (it runs in the webhook function);
the SQL/sandbox steps show in the **Workflow dashboard**.

## Stack

- **Next.js 16** (App Router) + React 19 — single route: `app/api/webhooks/[platform]/route.ts`
- **chat-sdk** + adapters: `@chat-adapter/{slack,github,linear,state-pg}`
- **AI SDK v6** (`ToolLoopAgent`, structured-output intent router)
- **Vercel Workflow DevKit** — durable PR-review & DB-question pipelines
- **Vercel Sandbox** — isolated clone/run/query execution
- **Vercel Postgres (Neon)** — chat state, demo e-commerce data, run observability
- **Vercel Blob** — screenshot storage for the vision pass
- **Vercel AI Gateway** — model routing (Anthropic Claude)

## Project layout

```
app/api/webhooks/[platform]/route.ts   single webhook → bot.webhooks[platform]
lib/bot.ts                             Chat instance, adapters, routing logic
lib/intent.ts                          LLM intent router (db_question / pr_review / chat)
lib/agents/                            agent registry (helpful, pr-reviewer, db-analyst)
lib/db/                                demo e-commerce schema + seed script
lib/sandbox/, lib/github/, lib/blob.ts sandbox runner, GitHub App auth, blob upload
workflows/                             durable pipelines + their steps
```

## Before you develop

Install the official Vercel agent skills first — they teach your coding agent the
real (frequently-changing) APIs of each SDK and point it at the bundled docs in
`node_modules/`. This repo uses three:

```sh
npx skills.sh add github:vercel/chat/skills/chat          # chat-sdk (bot + adapters)
npx skills.sh add github:vercel/workflow/skills/workflow  # Workflow DevKit (durable pipelines)
npx skills.sh add github:vercel/sandbox/skills/sandbox    # Vercel Sandbox (ephemeral execution)
```

> ⚠️ This repo runs a pre-release **Next.js 16**. APIs and conventions differ from older versions — see `AGENTS.md` and the bundled docs in `node_modules/next/dist/docs/`.

## Setup

1. **Install deps** (pnpm):
   ```sh
   pnpm install
   ```
2. **Configure env** — copy `.env.example` to `.env.local` and fill in:
   ```
   POSTGRES_URL          # Neon / Vercel Postgres
   AI_GATEWAY_API_KEY    # Vercel AI Gateway
   SLACK_BOT_TOKEN
   SLACK_SIGNING_SECRET
   GITHUB_APP_ID
   GITHUB_PRIVATE_KEY
   GITHUB_WEBHOOK_SECRET
   # LINEAR_API_KEY      # optional — Linear adapter registers only if both are set
   # LINEAR_WEBHOOK_SECRET
   ```
3. **Seed the demo DB** (e-commerce tables + sample data for the DB workflow):
   ```sh
   pnpm seed
   ```
4. **Run locally**:
   ```sh
   pnpm dev
   ```
5. **Deploy to Vercel** and point each platform's webhook at:
   ```
   <deployment-url>/api/webhooks/slack
   <deployment-url>/api/webhooks/github
   <deployment-url>/api/webhooks/linear   # optional
   ```
   A reference Slack app manifest lives at `slack-manifest.yaml`.

## License

MIT — see [LICENSE](./LICENSE).

