// One SQL dialect (PostgreSQL) for every environment.
//  - DATABASE_URL set  -> real PostgreSQL server (production, scales to millions of rows)
//  - otherwise         -> embedded PostgreSQL (PGlite) stored in ./pgdata, zero setup for local use
export async function openDb() {
  let query, exec, kind;
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX || 10),
      ssl: process.env.PGSSL === "require" ? { rejectUnauthorized: false } : undefined,
    });
    query = (sql, params) => pool.query(sql, params);
    exec = (sql) => pool.query(sql);
    kind = "postgres";
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const lite = new PGlite(process.env.PGLITE_DIR || "./pgdata");
    await lite.waitReady;
    query = (sql, params) => lite.query(sql, params);
    exec = (sql) => lite.exec(sql);
    kind = "embedded";
  }

  await exec(`
    CREATE TABLE IF NOT EXISTS users (
      id         text PRIMARY KEY,
      email      text NOT NULL UNIQUE,
      pw_salt    text NOT NULL,
      pw_hash    text NOT NULL,
      profile    jsonb NOT NULL DEFAULT '{}',
      terms_at   timestamptz,
      created    timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS wardrobe (
      id       text PRIMARY KEY,
      user_id  text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name     text NOT NULL,
      category text NOT NULL DEFAULT 'Top',
      color    text NOT NULL DEFAULT '',
      created  timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS wardrobe_user_idx ON wardrobe (user_id, created DESC);
    CREATE TABLE IF NOT EXISTS outfits (
      id           text PRIMARY KEY,
      user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      saved        boolean NOT NULL DEFAULT false,
      brief        jsonb NOT NULL DEFAULT '{}',
      title        text NOT NULL,
      direction    text NOT NULL DEFAULT '',
      why_it_works text NOT NULL DEFAULT '',
      color_note   text NOT NULL DEFAULT '',
      body_note    text NOT NULL DEFAULT '',
      est_total    text NOT NULL DEFAULT '',
      items        jsonb NOT NULL DEFAULT '[]',
      created      timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS outfits_user_idx ON outfits (user_id, created DESC);
    CREATE TABLE IF NOT EXISTS reset_tokens (
      token_hash text PRIMARY KEY,
      user_id    text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires    timestamptz NOT NULL
    );
  `);

  const rows = async (sql, params) => (await query(sql, params)).rows;
  const one = async (sql, params) => (await rows(sql, params))[0] ?? null;
  return { kind, rows, one, run: query };
}
