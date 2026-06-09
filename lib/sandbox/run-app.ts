import type { Sandbox } from "@vercel/sandbox";

/**
 * Pure-ish helpers for the runtime QA lane: detect whether a checked-out repo is
 * a runnable web app, install its deps, boot the dev server inside the microVM,
 * install + drive a headless browser, and read screenshots back out.
 *
 * All of these run *inside* the fat sandbox step (the live dev server can't cross
 * step boundaries). They throw `NotRunnable` for the "this PR isn't a runnable
 * web app" path so the caller can degrade to a static-only review.
 */

export const REPO_DIR = "/vercel/sandbox";
export const SHOTS_DIR = "/vercel/sandbox/.shots";
export const DEV_PORT = 3000;

/** Thrown when the repo can't be booted as a web app; caller degrades gracefully. */
export class NotRunnable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotRunnable";
  }
}

export type PackageManager = "pnpm" | "npm" | "yarn";

export interface Runnable {
  runnable: boolean;
  pm: PackageManager;
  devCmd: string;
  framework: string | null;
  reason?: string;
}

// Web frameworks whose presence (+ a dev/start script) marks a repo runnable.
const FRAMEWORK_DEPS: Array<[string, string]> = [
  ["next", "Next.js"],
  ["vite", "Vite"],
  ["react-scripts", "Create React App"],
  ["astro", "Astro"],
  ["nuxt", "Nuxt"],
  ["@remix-run/dev", "Remix"],
  ["@sveltejs/kit", "SvelteKit"],
];

/**
 * Decide whether `package.json` describes a runnable web app and how to run it.
 * Runnable iff there's a `dev` (or `start`) script AND a known web framework dep.
 */
export function detectRunnable(
  pkgJson: Record<string, unknown> | null,
  lockfiles: string[] = [],
): Runnable {
  const pm = detectPm(lockfiles);
  if (!pkgJson) {
    return { runnable: false, pm, devCmd: "", framework: null, reason: "no package.json" };
  }

  const scripts = (pkgJson.scripts ?? {}) as Record<string, string>;
  const deps = {
    ...((pkgJson.dependencies ?? {}) as Record<string, string>),
    ...((pkgJson.devDependencies ?? {}) as Record<string, string>),
  };

  const match = FRAMEWORK_DEPS.find(([dep]) => dep in deps);
  const framework = match?.[1] ?? null;

  const script = scripts.dev ? "dev" : scripts.start ? "start" : null;
  if (!script) {
    return { runnable: false, pm, devCmd: "", framework, reason: "no dev/start script" };
  }
  if (!framework) {
    return { runnable: false, pm, devCmd: "", framework: null, reason: "no known web framework dep" };
  }

  return { runnable: true, pm, devCmd: `${pm} run ${script}`, framework };
}

function detectPm(lockfiles: string[]): PackageManager {
  if (lockfiles.includes("pnpm-lock.yaml")) return "pnpm";
  if (lockfiles.includes("yarn.lock")) return "yarn";
  if (lockfiles.includes("package-lock.json")) return "npm";
  return "pnpm";
}

/** Run a command in the repo dir, throwing with captured output on non-zero exit. */
async function run(
  sandbox: Sandbox,
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<string> {
  const result = await sandbox.runCommand({
    cmd,
    args,
    cwd: REPO_DIR,
    timeoutMs: opts.timeoutMs,
    env: opts.env,
  });
  const out = await result.stdout();
  if (result.exitCode !== 0) {
    const err = await result.stderr();
    throw new Error(
      `\`${cmd} ${args.join(" ")}\` exited ${result.exitCode}: ${(err || out).slice(-800)}`,
    );
  }
  return out;
}

/** Install dependencies with the detected package manager. Hard-capped. */
export async function installDeps(
  sandbox: Sandbox,
  pm: PackageManager,
  timeoutMs = 6 * 60_000,
): Promise<void> {
  const args = pm === "yarn" ? ["install", "--frozen-lockfile"] : ["install"];
  try {
    await run(sandbox, pm, args, { timeoutMs });
  } catch (err) {
    // Retry once without the frozen/lockfile constraint — PR may touch deps.
    const msg = err instanceof Error ? err.message : String(err);
    if (pm === "yarn") {
      await run(sandbox, pm, ["install"], { timeoutMs });
    } else {
      throw new NotRunnable(`install failed: ${msg}`);
    }
  }
}

const CHROMIUM_SYSTEM_DEPS = [
  "nss", "nspr", "libxkbcommon", "atk", "at-spi2-atk", "at-spi2-core",
  "libXcomposite", "libXdamage", "libXrandr", "libXfixes", "libXcursor",
  "libXi", "libXtst", "libXScrnSaver", "libXext", "mesa-libgbm", "libdrm",
  "mesa-libGL", "mesa-libEGL", "cups-libs", "alsa-lib", "pango", "cairo",
  "gtk3", "dbus-libs",
];

/**
 * Install agent-browser + Chromium into the microVM (the dominant new cost,
 * ~30s one-time). Mirrors the agent-browser `vercel-sandbox` skill.
 */
export async function installBrowser(sandbox: Sandbox, timeoutMs = 5 * 60_000): Promise<void> {
  await run(sandbox, "sh", [
    "-c",
    `sudo dnf install -y --skip-broken ${CHROMIUM_SYSTEM_DEPS.join(" ")} 2>&1 && sudo ldconfig 2>&1`,
  ], { timeoutMs });
  await run(sandbox, "npm", ["install", "-g", "agent-browser"], { timeoutMs });
  await run(sandbox, "npx", ["agent-browser", "install"], { timeoutMs });
}

/**
 * Boot the dev server detached on {@link DEV_PORT}. Returns once `waitForPort`
 * confirms it's serving, or throws `NotRunnable` on boot timeout.
 */
export async function bootDevServer(
  sandbox: Sandbox,
  dev: Runnable,
  bootTimeoutMs = 90_000,
): Promise<void> {
  const [pm, , script] = dev.devCmd.split(" "); // "pnpm run dev"
  // Detached: keeps running in the session after this call resolves.
  await sandbox.runCommand({
    cmd: pm,
    args: ["run", script],
    cwd: REPO_DIR,
    detached: true,
    env: { PORT: String(DEV_PORT), HOST: "0.0.0.0" },
  });
  await waitForPort(sandbox, DEV_PORT, bootTimeoutMs);
}

/** Poll `curl localhost:<port>` until it answers (any HTTP code) or times out. */
export async function waitForPort(
  sandbox: Sandbox,
  port: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastCode = "000";
  while (Date.now() < deadline) {
    const res = await sandbox.runCommand("bash", [
      "-c",
      `curl -s -o /dev/null -w '%{http_code}' http://localhost:${port} || true`,
    ]);
    lastCode = (await res.stdout()).trim();
    // Any non-000 means the server accepted the connection and replied.
    if (lastCode && lastCode !== "000") return;
    await sleep(2000);
  }
  throw new NotRunnable(`dev server never answered on :${port} (last status ${lastCode})`);
}

export interface ShotPlanStep {
  /** File-safe name, no extension (e.g. "01-todos"). */
  name: string;
  /** agent-browser argv arrays run in order before the screenshot. */
  commands: string[][];
}

/**
 * Drive agent-browser inside the sandbox to capture deterministic baseline
 * screenshots. Each step opens/interacts then screenshots to {@link SHOTS_DIR}.
 * Per-step try/catch: one bad route never sinks the rest.
 */
export async function captureScreens(
  sandbox: Sandbox,
  steps: ShotPlanStep[],
): Promise<{ captured: string[]; failures: string[] }> {
  await sandbox.runCommand("mkdir", ["-p", SHOTS_DIR]);
  const captured: string[] = [];
  const failures: string[] = [];

  for (const step of steps) {
    try {
      for (const argv of step.commands) {
        await run(sandbox, "agent-browser", argv);
      }
      await run(sandbox, "agent-browser", ["screenshot", `${SHOTS_DIR}/${step.name}.png`]);
      captured.push(step.name);
    } catch (err) {
      failures.push(`${step.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await sandbox.runCommand("agent-browser", ["close"]).catch(() => {});
  return { captured, failures };
}

export interface Shot {
  name: string;
  label: string;
  buf: Buffer;
}

/** Read every PNG in {@link SHOTS_DIR} out of the sandbox, with a derived label. */
export async function readShots(sandbox: Sandbox): Promise<Shot[]> {
  const res = await sandbox.runCommand("bash", [
    "-c",
    `ls -1 ${SHOTS_DIR}/*.png 2>/dev/null || true`,
  ]);
  const paths = (await res.stdout()).trim().split("\n").filter(Boolean);

  const shots: Shot[] = [];
  for (const path of paths) {
    const buf = await sandbox.readFileToBuffer({ path });
    if (!buf) continue;
    const file = path.split("/").pop() ?? path;
    const name = file.replace(/\.png$/, "");
    shots.push({ name, label: labelFromName(name), buf });
  }
  return shots;
}

/** "01-todos-after-add" → "todos after add". */
function labelFromName(name: string): string {
  return name.replace(/^\d+-/, "").replace(/-/g, " ").trim() || name;
}

/**
 * Map changed Next App-Router files to URL routes worth screenshotting.
 * `app/todos/page.tsx` → `/todos`, `app/page.tsx` → `/`. Skips dynamic
 * segments (`[id]`) we can't fill, and drops route-group `(group)` dirs.
 */
export function routesFromChangedFiles(files: string[]): string[] {
  const routes = new Set<string>();
  for (const f of files) {
    const m = f.match(/^app\/(.*\/)?page\.(tsx|ts|jsx|js|mdx)$/);
    if (!m) continue;
    const segs = (m[1] ?? "")
      .split("/")
      .filter(Boolean)
      .filter((s) => !(s.startsWith("(") && s.endsWith(")"))); // route groups
    if (segs.some((s) => s.includes("["))) continue; // dynamic — can't fill
    routes.add("/" + segs.join("/"));
  }
  return [...routes];
}

/** Deterministic baseline: home first, then each changed route (capped). */
export function baselinePlan(routes: string[], max = 3): ShotPlanStep[] {
  const ordered = ["/", ...routes.filter((r) => r !== "/")].slice(0, max + 1);
  return ordered.map((route, i) => ({
    name: `${String(i).padStart(2, "0")}-${routeLabel(route)}`,
    commands: [["open", `http://localhost:${DEV_PORT}${route}`], ["wait", "1500"]],
  }));
}

function routeLabel(route: string): string {
  if (route === "/") return "home";
  return route.replace(/^\//, "").replace(/\//g, "-") || "home";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
