import Database from 'better-sqlite3';

export function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      image TEXT
    );

    CREATE TABLE IF NOT EXISTS skins (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      weapon_name TEXT NOT NULL,
      pattern_name TEXT NOT NULL,
      rarity INTEGER NOT NULL,
      min_float REAL NOT NULL,
      max_float REAL NOT NULL,
      has_stattrak INTEGER NOT NULL DEFAULT 0,
      collection_id TEXT NOT NULL,
      FOREIGN KEY (collection_id) REFERENCES collections(id)
    );

    CREATE INDEX IF NOT EXISTS idx_skins_rarity ON skins(rarity);
    CREATE INDEX IF NOT EXISTS idx_skins_collection ON skins(collection_id);

    CREATE TABLE IF NOT EXISTS tradeup_results (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      input_rarity INTEGER NOT NULL,
      input_json TEXT NOT NULL,
      ev_cents INTEGER NOT NULL,
      profit_cents INTEGER NOT NULL,
      roi REAL NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tradeup_roi ON tradeup_results(roi DESC);

    -- Maps weapon cases (crates) to their Covert skin inputs for knife/glove trade-ups.
    CREATE TABLE IF NOT EXISTS case_covert_skins (
      crate_id TEXT NOT NULL,
      skin_id  TEXT NOT NULL,
      PRIMARY KEY (crate_id, skin_id)
    );
    CREATE INDEX IF NOT EXISTS idx_case_covert_crate ON case_covert_skins(crate_id);

    -- Maps weapon cases (crates) to the knife/glove skins in their rare output pool.
    CREATE TABLE IF NOT EXISTS case_extraordinary_skins (
      crate_id TEXT NOT NULL,
      skin_id  TEXT NOT NULL,
      PRIMARY KEY (crate_id, skin_id)
    );
    CREATE INDEX IF NOT EXISTS idx_case_extra_crate ON case_extraordinary_skins(crate_id);
  `);

  // ── price_history table ───────────────────────────────────────────────────
  db.exec(`
    CREATE TABLE IF NOT EXISTS price_history (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      skin_id    TEXT    NOT NULL,
      condition  TEXT    NOT NULL,
      stattrak   INTEGER NOT NULL DEFAULT 0,
      source     TEXT    NOT NULL DEFAULT 'csfloat',
      price_cents INTEGER NOT NULL,
      volume     INTEGER NOT NULL DEFAULT 0,
      recorded_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ph_skin   ON price_history(skin_id, condition, stattrak, source);
    CREATE INDEX IF NOT EXISTS idx_ph_date   ON price_history(recorded_at);
    CREATE INDEX IF NOT EXISTS idx_ph_source ON price_history(source, recorded_at);
  `);

  // ── skins table — add def_index/paint_index columns if missing ───────────
  {
    const skinCols = (db.pragma('table_info(skins)') as { name: string }[]).map(r => r.name);
    if (!skinCols.includes('def_index')) {
      db.exec('ALTER TABLE skins ADD COLUMN def_index INTEGER');
    }
    if (!skinCols.includes('paint_index')) {
      db.exec('ALTER TABLE skins ADD COLUMN paint_index TEXT');
    }
  }

  // ── prices table — recreate if it lacks the 'source' column ──────────────
  // The source column is part of the PRIMARY KEY (skin_id, condition, stattrak, source)
  // so we store Steam and CSFloat prices independently side-by-side.
  const cols = (db.pragma('table_info(prices)') as { name: string }[]).map(r => r.name);

  if (cols.length === 0) {
    // Table doesn't exist yet — create fresh
    db.exec(`
      CREATE TABLE prices (
        skin_id    TEXT    NOT NULL,
        condition  TEXT    NOT NULL,
        stattrak   INTEGER NOT NULL DEFAULT 0,
        source     TEXT    NOT NULL DEFAULT 'csfloat',
        price_cents INTEGER NOT NULL,
        volume     INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (skin_id, condition, stattrak, source)
      );
      CREATE INDEX IF NOT EXISTS idx_prices_updated ON prices(updated_at);
      CREATE INDEX IF NOT EXISTS idx_prices_source  ON prices(source);
    `);
  } else if (!cols.includes('source')) {
    // Old schema without source — migrate by recreating
    console.log('Migrating prices table to add source column…');
    db.exec(`
      ALTER TABLE prices RENAME TO prices_old;
      CREATE TABLE prices (
        skin_id    TEXT    NOT NULL,
        condition  TEXT    NOT NULL,
        stattrak   INTEGER NOT NULL DEFAULT 0,
        source     TEXT    NOT NULL DEFAULT 'csfloat',
        price_cents INTEGER NOT NULL,
        volume     INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (skin_id, condition, stattrak, source)
      );
      CREATE INDEX IF NOT EXISTS idx_prices_updated ON prices(updated_at);
      CREATE INDEX IF NOT EXISTS idx_prices_source  ON prices(source);
      INSERT OR IGNORE INTO prices (skin_id, condition, stattrak, source, price_cents, volume, updated_at)
        SELECT skin_id, condition, stattrak, 'csfloat', price_cents, volume, updated_at FROM prices_old;
      DROP TABLE prices_old;
    `);
    console.log('prices table migration complete.');
  }
  // else: table exists with correct schema — nothing to do
}
