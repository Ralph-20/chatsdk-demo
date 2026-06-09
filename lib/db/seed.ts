import { ensureDemoSchema } from "./demo-schema";

/**
 * Seed the demo e-commerce tables with deterministic fake data so Slack "db:"
 * questions have something to chew on. Repeatable: TRUNCATEs then reseeds, so
 * row counts and ids are stable across runs.
 *
 * Run with: `pnpm seed` (loads POSTGRES_URL via --env-file=.env.local).
 */

const COUNTRIES = ["US", "UK", "DE", "FR", "CA", "AU", "BR", "JP"];
const FIRST = ["Ava", "Liam", "Mia", "Noah", "Ada", "Leo", "Zoe", "Kai", "Ivy", "Max"];
const LAST = ["Stone", "Reyes", "Park", "Cohen", "Diaz", "Okafor", "Singh", "Lund"];

const CATEGORIES = ["Electronics", "Books", "Home", "Clothing", "Toys"];
const PRODUCT_NAMES = [
  "Wireless Earbuds", "USB-C Hub", "Mechanical Keyboard", // Electronics
  "Clean Code", "The Pragmatic Programmer", "Dune", // Books
  "Ceramic Mug", "Throw Blanket", "Desk Lamp", // Home
  "Cotton Tee", "Denim Jacket", "Wool Socks", // Clothing
  "Building Blocks", "Plush Bear", "Puzzle Cube", // Toys
];
const STATUSES = ["pending", "paid", "shipped", "cancelled"];

const N_CUSTOMERS = 20;
const N_ORDERS = 50;

async function main(): Promise<void> {
  // Dynamic import: state-pg is ESM-only, so a CJS-context tsx run can't
  // `require` it — `import()` uses ESM resolution and loads it fine.
  const { createPostgresState } = await import("@chat-adapter/state-pg");
  const pool = createPostgresState().getClient();
  await ensureDemoSchema(pool);

  // Child-first truncate; RESTART IDENTITY makes ids deterministic per run.
  await pool.query(
    `TRUNCATE demo_order_items, demo_orders, demo_products, demo_customers RESTART IDENTITY CASCADE`,
  );

  // Customers (20).
  for (let i = 0; i < N_CUSTOMERS; i++) {
    const name = `${FIRST[i % FIRST.length]} ${LAST[i % LAST.length]}`;
    const email = `${name.toLowerCase().replace(/\W+/g, ".")}${i}@example.com`;
    const country = COUNTRIES[i % COUNTRIES.length];
    await pool.query(
      `INSERT INTO demo_customers (name, email, country) VALUES ($1, $2, $3)`,
      [name, email, country],
    );
  }

  // Products (15) — price $5–$199, category cycles in groups of 3 names.
  for (let i = 0; i < PRODUCT_NAMES.length; i++) {
    const category = CATEGORIES[Math.floor(i / 3) % CATEGORIES.length];
    const priceCents = 500 + ((i * 1373) % 19500); // 500..~19999, spread out
    await pool.query(
      `INSERT INTO demo_products (name, category, price_cents) VALUES ($1, $2, $3)`,
      [PRODUCT_NAMES[i], category, priceCents],
    );
  }

  // Pull back ids + prices for FK references.
  const { rows: products } = await pool.query<{ id: number; price_cents: number }>(
    `SELECT id, price_cents FROM demo_products ORDER BY id`,
  );

  // Orders (50) + 1–3 items each (~100–150 order_items total).
  for (let o = 0; o < N_ORDERS; o++) {
    const customerId = (o % N_CUSTOMERS) + 1;
    const status = STATUSES[o % STATUSES.length];
    const {
      rows: [order],
    } = await pool.query<{ id: number }>(
      `INSERT INTO demo_orders (customer_id, status) VALUES ($1, $2) RETURNING id`,
      [customerId, status],
    );

    const itemCount = (o % 3) + 1;
    for (let k = 0; k < itemCount; k++) {
      const p = products[(o * 3 + k) % products.length];
      const quantity = ((o + k) % 4) + 1;
      await pool.query(
        `INSERT INTO demo_order_items (order_id, product_id, quantity, unit_price_cents)
         VALUES ($1, $2, $3, $4)`,
        [order.id, p.id, quantity, p.price_cents],
      );
    }
  }

  const counts = await pool.query<{ table: string; n: string }>(
    `SELECT 'customers' AS table, count(*)::text AS n FROM demo_customers
     UNION ALL SELECT 'products', count(*)::text FROM demo_products
     UNION ALL SELECT 'orders', count(*)::text FROM demo_orders
     UNION ALL SELECT 'order_items', count(*)::text FROM demo_order_items`,
  );
  console.log(
    "[seed] done:",
    Object.fromEntries(counts.rows.map((r: { table: string; n: string }) => [r.table, r.n])),
  );

  await pool.end();
}

main().catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
