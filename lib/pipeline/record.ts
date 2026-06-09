import { createPostgresState } from "@chat-adapter/state-pg";

// Derive the pg.Pool type from the adapter so we don't need a direct `pg` dep.
type Pool = ReturnType<ReturnType<typeof createPostgresState>["getClient"]>;

/**
 * Thin step-state capture for the PR-review pipeline. Writes run + step rows to
 * Postgres (reusing the state-pg pool) so a later visualization page has its own
 * event source alongside the WDK Observability dashboard.
 *
 * All writes are best-effort: recording must never break a review. Call these
 * only from inside `"use step"` functions — never the deterministic workflow body.
 */

let _pool: Pool | null = null;
let _ready: Promise<void> | null = null;

function pool(): Pool {
  if (!_pool) _pool = createPostgresState().getClient();
  return _pool;
}

function ensureSchema(): Promise<void> {
  if (_ready) return _ready;
  const ready = pool()
    .query(
      `
        CREATE TABLE IF NOT EXISTS pipeline_runs (
          run_id     text PRIMARY KEY,
          meta       jsonb NOT NULL DEFAULT '{}'::jsonb,
          status     text  NOT NULL DEFAULT 'running',
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE TABLE IF NOT EXISTS pipeline_steps (
          id         bigserial PRIMARY KEY,
          run_id     text NOT NULL,
          step       text NOT NULL,
          status     text NOT NULL,
          data       jsonb,
          created_at timestamptz NOT NULL DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS pipeline_steps_run_idx ON pipeline_steps (run_id);
      `,
    )
    .then(() => undefined);
  _ready = ready;
  return ready;
}

export async function recordRun(
  runId: string,
  meta: Record<string, unknown> & { status?: string; error?: string },
): Promise<void> {
  try {
    await ensureSchema();
    const status = meta.status ?? "running";
    await pool().query(
      `INSERT INTO pipeline_runs (run_id, meta, status) VALUES ($1, $2, $3)
       ON CONFLICT (run_id) DO UPDATE
         SET meta = pipeline_runs.meta || EXCLUDED.meta,
             status = EXCLUDED.status,
             updated_at = now()`,
      [runId, JSON.stringify(meta), status],
    );
  } catch (err) {
    console.error("[pipeline] recordRun failed:", err);
  }
}

/**
 * Whether a review for this exact PR is already running. Used to de-dupe
 * triggers so a second @-mention (or a spammed one) doesn't spin up a duplicate
 * sandbox. Best-effort: any error returns false so recording never blocks a run.
 */
export async function hasRunningReview(
  owner: string,
  repo: string,
  prNumber: number,
): Promise<boolean> {
  try {
    await ensureSchema();
    const { rows } = await pool().query(
      `SELECT 1 FROM pipeline_runs
        WHERE status = 'running'
          AND meta->>'owner' = $1
          AND meta->>'repo' = $2
          AND meta->>'prNumber' = $3
        LIMIT 1`,
      [owner, repo, String(prNumber)],
    );
    return rows.length > 0;
  } catch (err) {
    console.error("[pipeline] hasRunningReview failed:", err);
    return false;
  }
}

export async function recordStep(
  runId: string,
  step: string,
  status: string,
  data?: Record<string, unknown>,
): Promise<void> {
  try {
    await ensureSchema();
    await pool().query(
      `INSERT INTO pipeline_steps (run_id, step, status, data) VALUES ($1, $2, $3, $4)`,
      [runId, step, status, data ? JSON.stringify(data) : null],
    );
  } catch (err) {
    console.error("[pipeline] recordStep failed:", err);
  }
}
