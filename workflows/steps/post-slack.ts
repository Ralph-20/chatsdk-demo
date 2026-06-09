import { WebClient, type KnownBlock } from "@slack/web-api";
import { recordStep } from "@/lib/pipeline/record";
import type { Shot } from "./review-in-sandbox";

/**
 * Post the review back into the Slack thread that asked for it. Constructs a
 * bot-token WebClient directly (the adapter's post path is request-bound and
 * unavailable in a durable step). Renders the review as mrkdwn section blocks
 * plus an image block per screenshot.
 */
export async function postSlackStep(input: {
  runId: string;
  channel: string;
  threadTs: string;
  body: string;
  shots?: Shot[];
  /** label distinguishes the review from the failure note in records */
  label?: string;
}): Promise<void> {
  "use step";
  const { runId, channel, threadTs, body, shots = [], label = "postSlack" } = input;

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error("SLACK_BOT_TOKEN not configured");

  const client = new WebClient(token);
  await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: body.slice(0, 3000), // notification/fallback text
    blocks: buildBlocks(body, shots),
  });

  await recordStep(runId, label, "completed", { shots: shots.length });
}

// Slack section text caps at 3000 chars and image blocks need a public URL +
// alt_text. Chunk the (markdown→mrkdwn) review across sections, then append one
// image block per screenshot with its label as a context line above it.
function buildBlocks(body: string, shots: Shot[]): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  for (const part of chunk(toMrkdwn(body), 2900)) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: part } });
  }
  if (shots.length) {
    blocks.push({ type: "divider" });
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*What I saw* — ran it and exercised it in a headless browser.` },
    });
    for (const s of shots) {
      blocks.push({
        type: "image",
        image_url: s.url,
        alt_text: s.label.slice(0, 2000) || "screenshot",
        title: { type: "plain_text", text: s.label.slice(0, 150) || "screenshot" },
      });
    }
  }
  // Slack rejects >50 blocks; keep headroom (review chunks + images).
  return blocks.slice(0, 50);
}

/** Light GitHub-markdown → Slack-mrkdwn conversion (tables, bold, headers, bullets). */
function toMrkdwn(md: string): string {
  return tablesToCodeBlocks(md) // before bullets: table separators look like bullets
    .replace(/^#{1,6}\s+(.*)$/gm, "*$1*") // headers → bold
    .replace(/\*\*(.+?)\*\*/g, "*$1*") // **bold** → *bold*
    .replace(/^\s*[-*]\s+/gm, "• "); // bullets
}

// Slack mrkdwn has no table support, so a GitHub-style table renders as raw
// pipes. Convert each table to an aligned, monospaced code block (which Slack
// does render) so columns line up instead of becoming `| a | b |` soup.
function tablesToCodeBlocks(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const isRow = (l?: string) => !!l && /^\s*\|.*\|\s*$/.test(l);
    const isSep = (l?: string) => !!l && /^\s*\|?[\s:|-]+\|?\s*$/.test(l) && l.includes("-");
    if (isRow(lines[i]) && isSep(lines[i + 1])) {
      const cells = (l: string) =>
        l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const header = cells(lines[i]);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (isRow(lines[i])) rows.push(cells(lines[i++]));

      const grid = [header, ...rows];
      const widths = header.map((_, c) => Math.max(...grid.map((r) => (r[c] ?? "").length)));
      const fmt = (r: string[]) =>
        r.map((c, c2) => (c ?? "").padEnd(widths[c2])).join("  ").trimEnd();
      const body = [fmt(header), widths.map((w) => "-".repeat(w)).join("  "), ...rows.map(fmt)];
      out.push("```\n" + body.join("\n") + "\n```");
      continue;
    }
    out.push(lines[i++]);
  }
  return out.join("\n");
}

function chunk(s: string, size: number): string[] {
  if (s.length <= size) return [s];
  const out: string[] = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}
