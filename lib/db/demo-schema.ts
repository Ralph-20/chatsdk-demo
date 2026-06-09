import type { createPostgresState } from "@chat-adapter/state-pg";

// Derive the pg.Pool type from the adapter so we don't need a direct `pg` dep
// (same trick as lib/pipeline/record.ts). Type-only import: this module carries
// no runtime dependency on the ESM-only state-pg package.
type Pool = ReturnType<ReturnType<typeof createPostgresState>["getClient"]>;

/**
 * Single source of truth for the demo e-commerce schema. Both the seed script
 * and the DB-analyst agent's prompt read from here so SQL and prose never drift.
 *
 * Tables are prefixed `demo_` so they never collide with chat-state or the
 * `pipeline_*` observability tables sharing this Neon DB.
 */

export const DEMO_SCHEMA_DDL = `
  CREATE TABLE IF NOT EXISTS demo_customers (
    id         serial PRIMARY KEY,
    name       text NOT NULL,
    email      text NOT NULL,
    country    text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS demo_products (
    id          serial PRIMARY KEY,
    name        text NOT NULL,
    category    text NOT NULL,
    price_cents integer NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS demo_orders (
    id          serial PRIMARY KEY,
    customer_id integer NOT NULL REFERENCES demo_customers (id),
    status      text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS demo_order_items (
    id               serial PRIMARY KEY,
    order_id         integer NOT NULL REFERENCES demo_orders (id),
    product_id       integer NOT NULL REFERENCES demo_products (id),
    quantity         integer NOT NULL,
    unit_price_cents integer NOT NULL
  );
`;

/** Idempotent DDL apply (mirrors ensureSchema() in lib/pipeline/record.ts). */
export async function ensureDemoSchema(pool: Pool): Promise<void> {
  await pool.query(DEMO_SCHEMA_DDL);
}

/**
 * Plain-text schema fed verbatim into the agent's system prompt so it writes
 * correct SQL without a discovery round-trip.
 */
export const SCHEMA_DESCRIPTION = `
demo_customers(id, name, email, country, created_at)
demo_products(id, name, category, price_cents, created_at)
demo_orders(id, customer_id -> demo_customers.id, status, created_at)
demo_order_items(id, order_id -> demo_orders.id, product_id -> demo_products.id, quantity, unit_price_cents)

Notes:
- Money is stored in integer cents (price_cents, unit_price_cents). Divide by 100.0 for dollars.
- order_items.unit_price_cents is the price captured at order time; prefer it over products.price_cents for revenue.
- demo_orders.status is one of: 'pending', 'paid', 'shipped', 'cancelled'.
- demo_products.category is one of: 'Electronics', 'Books', 'Home', 'Clothing', 'Toys'.
`.trim();
