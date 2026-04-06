import { getDb } from '../db/client.js';
import { fetchCollections } from '../api/collections.js';
import { fetchAllPricesBulk, PriceSource } from '../api/bulk-prices.js';
import { buildMarketHashName } from '../api/prices.js';
import { Skin } from '../models/types.js';
import { Rarity, Condition, CONDITION_FLOAT_RANGES } from '../models/enums.js';

// ─────────────────────────────────────────────────────────────────
// Static data: collections + skins
// ─────────────────────────────────────────────────────────────────

export async function syncCollectionsAndSkins(): Promise<void> {
  const { collections, skins, caseCovertMap, caseOutputMap } = await fetchCollections();
  const db = getDb();

  // Ensure case bridge tables exist (migration for existing DBs)
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_covert_skins (
      crate_id TEXT NOT NULL,
      skin_id  TEXT NOT NULL,
      PRIMARY KEY (crate_id, skin_id)
    );
    CREATE INDEX IF NOT EXISTS idx_case_covert_crate ON case_covert_skins(crate_id);

    CREATE TABLE IF NOT EXISTS case_extraordinary_skins (
      crate_id TEXT NOT NULL,
      skin_id  TEXT NOT NULL,
      PRIMARY KEY (crate_id, skin_id)
    );
    CREATE INDEX IF NOT EXISTS idx_case_extra_crate ON case_extraordinary_skins(crate_id);
  `);

  const insertCollection = db.prepare(
    'INSERT OR REPLACE INTO collections (id, name, image) VALUES (?, ?, ?)'
  );
  const insertSkin = db.prepare(
    'INSERT OR REPLACE INTO skins (id, name, weapon_name, pattern_name, rarity, min_float, max_float, has_stattrak, collection_id, def_index, paint_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertCaseCovert = db.prepare(
    'INSERT OR IGNORE INTO case_covert_skins (crate_id, skin_id) VALUES (?, ?)'
  );
  const insertCaseOutput = db.prepare(
    'INSERT OR IGNORE INTO case_extraordinary_skins (crate_id, skin_id) VALUES (?, ?)'
  );

  const validSkinIds = new Set(skins.map(s => s.id));

  db.transaction(() => {
    for (const col of collections) {
      insertCollection.run(col.id, col.name, col.image ?? null);
    }
    for (const skin of skins) {
      insertSkin.run(
        skin.id, skin.name, skin.weaponName, skin.patternName,
        skin.rarity, skin.minFloat, skin.maxFloat,
        skin.hasStatTrak ? 1 : 0, skin.collectionId,
        skin.defIndex ?? null, skin.paintIndex != null ? String(skin.paintIndex) : null
      );
    }

    // Rebuild crate mappings
    db.prepare('DELETE FROM case_covert_skins').run();
    for (const [crateId, skinIds] of caseCovertMap) {
      for (const skinId of skinIds) {
        insertCaseCovert.run(crateId, skinId);
      }
    }

    db.prepare('DELETE FROM case_extraordinary_skins').run();
    for (const [crateId, skinIds] of caseOutputMap) {
      for (const skinId of skinIds) {
        insertCaseOutput.run(crateId, skinId);
      }
    }

    // Remove skins no longer in the API (stale entries like old charms/stickers)
    const allDbIds = (db.prepare('SELECT id FROM skins').all() as { id: string }[]).map(r => r.id);
    for (const id of allDbIds) {
      if (!validSkinIds.has(id)) {
        db.prepare('DELETE FROM skins WHERE id = ?').run(id);
        db.prepare('DELETE FROM prices WHERE skin_id = ?').run(id);
      }
    }
  })();

  invalidateCache();
  console.log(`Synced ${collections.length} collections (${caseCovertMap.size} knife/glove cases), ${skins.length} skins`);
}

// ─────────────────────────────────────────────────────────────────
// Bulk price sync — stores prices per source independently
// ─────────────────────────────────────────────────────────────────

export async function syncAllPrices(
  source: PriceSource = 'csfloat',
  onProgress?: (p: { done: number; total: number; itemsFetched: number; phase?: string }) => void
): Promise<number> {
  const db = getDb();

  // Archive current prices to history before clearing
  const now = Date.now();
  const archived = db.prepare(`
    INSERT INTO price_history (skin_id, condition, stattrak, source, price_cents, volume, recorded_at)
    SELECT skin_id, condition, stattrak, source, price_cents, volume, ?
    FROM prices WHERE source = ? AND price_cents > 0
  `).run(now, source).changes;
  if (archived > 0) console.log(`Archived ${archived} ${source} prices to history`);

  // Clean up history older than 30 days (keep ~monthly data)
  const cutoff = now - 30 * 24 * 60 * 60 * 1000;
  db.prepare('DELETE FROM price_history WHERE recorded_at < ?').run(cutoff);

  // Clear only prices for this source — the other source is untouched
  db.prepare('DELETE FROM prices WHERE source = ?').run(source);
  invalidateCache();
  console.log(`Cleared existing ${source} prices — fetching fresh data`);

  const allPrices = await fetchAllPricesBulk({ source, onProgress });
  const skins = db.prepare('SELECT * FROM skins').all() as any[];

  const upsert = db.prepare(`
    INSERT INTO prices (skin_id, condition, stattrak, source, price_cents, volume, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(skin_id, condition, stattrak, source)
    DO UPDATE SET price_cents = excluded.price_cents,
                  volume      = excluded.volume,
                  updated_at  = excluded.updated_at
  `);

  let synced = 0;
  const syncTime = Date.now();

  db.transaction(() => {
    for (const skin of skins) {
      for (const condition of validConditionsForSkin(skin)) {
        for (const stattrak of [false, ...(skin.has_stattrak ? [true] : [])]) {
          const hashName = buildMarketHashName(
            skin.weapon_name, skin.pattern_name, condition, stattrak
          );
          const entry = allPrices.get(hashName);
          if (entry && entry.priceCents > 0) {
            upsert.run(skin.id, condition, stattrak ? 1 : 0, source, entry.priceCents, entry.listings, syncTime);
            synced++;
          }
        }
      }
    }
  })();

  console.log(`Synced ${synced} ${source} prices for ${skins.length} skins`);
  invalidateCache();
  return synced;
}

// ─────────────────────────────────────────────────────────────────
// In-memory caches — populated on first use, invalidated after sync
// Cache key format: "skinId:condition:stattrak:source"
// ─────────────────────────────────────────────────────────────────

// skinsByCollRarity: "collectionId:rarity" → Skin[]
const skinsByCollRarity = new Map<string, Skin[]>();
// priceCache: "skinId:condition:stattrak:source" → price_cents
const priceCache = new Map<string, number>();
// volumeCache: "skinId:condition:stattrak:source" → listings
const volumeCache = new Map<string, number>();
// eligibleCache: "rarity:source" → string[]
const eligibleCache = new Map<string, string[]>();
// casesWithKnives cache
let casesWithKnivesCache: Map<string, Skin[]> | null = null;

let cacheLoaded = false;

function ensureCache(): void {
  if (cacheLoaded) return;
  const db = getDb();

  const allSkins = (db.prepare('SELECT * FROM skins').all() as any[]).map(rowToSkin);
  for (const skin of allSkins) {
    const key = `${skin.collectionId}:${skin.rarity}`;
    const arr = skinsByCollRarity.get(key) ?? [];
    arr.push(skin);
    skinsByCollRarity.set(key, arr);
  }

  const allPrices = db.prepare(
    'SELECT skin_id, condition, stattrak, source, price_cents, volume FROM prices WHERE price_cents > 0'
  ).all() as any[];
  for (const row of allPrices) {
    const key = `${row.skin_id}:${row.condition}:${row.stattrak}:${row.source}`;
    priceCache.set(key, row.price_cents);
    volumeCache.set(key, row.volume ?? 0);
  }

  cacheLoaded = true;
}

export function invalidateCache(): void {
  skinsByCollRarity.clear();
  priceCache.clear();
  volumeCache.clear();
  eligibleCache.clear();
  casesWithKnivesCache = null;
  cacheLoaded = false;
}

export interface CaseEntry {
  covertSkins: Skin[];
  outputSkins: Skin[];
}

/**
 * Returns a map of crate_id → { covertSkins, outputSkins } for all cases
 * that have both a Covert skin input pool and a knife/glove output pool.
 */
export function getCasesWithKnives(): Map<string, CaseEntry> {
  if (casesWithKnivesCache) return casesWithKnivesCache as Map<string, CaseEntry>;
  const db = getDb();
  ensureCache();

  const skinById = new Map<string, Skin>();
  for (const [, arr] of skinsByCollRarity) {
    for (const s of arr) skinById.set(s.id, s);
  }

  const covertRows = db.prepare(
    'SELECT crate_id, skin_id FROM case_covert_skins ORDER BY crate_id'
  ).all() as { crate_id: string; skin_id: string }[];

  const outputRows = db.prepare(
    'SELECT crate_id, skin_id FROM case_extraordinary_skins ORDER BY crate_id'
  ).all() as { crate_id: string; skin_id: string }[];

  const covertByCrate = new Map<string, Skin[]>();
  for (const row of covertRows) {
    const skin = skinById.get(row.skin_id);
    if (!skin) continue;
    const arr = covertByCrate.get(row.crate_id) ?? [];
    arr.push(skin);
    covertByCrate.set(row.crate_id, arr);
  }

  const outputByCrate = new Map<string, Skin[]>();
  for (const row of outputRows) {
    const skin = skinById.get(row.skin_id);
    if (!skin) continue;
    const arr = outputByCrate.get(row.crate_id) ?? [];
    arr.push(skin);
    outputByCrate.set(row.crate_id, arr);
  }

  const result = new Map<string, CaseEntry>();
  for (const [crateId, covertSkins] of covertByCrate) {
    const outputSkins = outputByCrate.get(crateId);
    if (!outputSkins?.length) continue;
    result.set(crateId, { covertSkins, outputSkins });
  }

  casesWithKnivesCache = result as any;
  return result;
}

export function getListings(skinId: string, condition: Condition, stattrak: boolean, source: PriceSource): number {
  ensureCache();
  return volumeCache.get(`${skinId}:${condition}:${stattrak ? 1 : 0}:${source}`) ?? 0;
}

// ─────────────────────────────────────────────────────────────────
// Eligibility: only skins in collections that have a next-tier
// ─────────────────────────────────────────────────────────────────

/** Collections where skins of BOTH rarity R and R+1 exist AND have prices for the given source */
export function getEligibleCollections(inputRarity: Rarity, source: PriceSource): string[] {
  ensureCache();
  const cacheKey = `${inputRarity}:${source}`;
  if (eligibleCache.has(cacheKey)) return eligibleCache.get(cacheKey)!;
  const outputRarity = (inputRarity + 1) as Rarity;
  const inputColls = new Set<string>();
  const outputColls = new Set<string>();
  for (const [key] of skinsByCollRarity) {
    const [cid, rStr] = key.split(':');
    const r = parseInt(rStr) as Rarity;
    if (r === inputRarity) inputColls.add(cid);
    if (r === outputRarity) outputColls.add(cid);
  }
  const result = [...inputColls].filter(c => outputColls.has(c));
  eligibleCache.set(cacheKey, result);
  return result;
}

/** All skins in a collection at a given rarity */
export function getSkinsInCollection(collectionId: string, rarity: Rarity): Skin[] {
  ensureCache();
  return skinsByCollRarity.get(`${collectionId}:${rarity}`) ?? [];
}

export function getCollectionName(collectionId: string): string {
  const db = getDb();
  const row = db.prepare('SELECT name FROM collections WHERE id = ?').get(collectionId) as any;
  return row?.name ?? collectionId;
}

export function getSkinsAtRarity(rarity: Rarity): Skin[] {
  const db = getDb();
  return (db.prepare('SELECT * FROM skins WHERE rarity = ?').all(rarity) as any[]).map(rowToSkin);
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function rowToSkin(row: any): Skin {
  return {
    id: row.id,
    name: row.name,
    weaponName: row.weapon_name,
    patternName: row.pattern_name,
    rarity: row.rarity as Rarity,
    minFloat: row.min_float,
    maxFloat: row.max_float,
    hasStatTrak: row.has_stattrak === 1,
    collectionId: row.collection_id,
    defIndex: row.def_index ?? undefined,
    paintIndex: row.paint_index != null ? parseInt(row.paint_index, 10) : undefined,
  };
}

/**
 * Return conditions that are valid for a given skin based on its float range.
 */
export function validConditionsForSkin(skin: { min_float: number; max_float: number }): Condition[] {
  const result: Condition[] = [];
  for (const [cond, [cMin, cMax]] of Object.entries(CONDITION_FLOAT_RANGES) as [Condition, [number, number]][]) {
    if (cMin < skin.max_float && cMax > skin.min_float) {
      result.push(cond);
    }
  }
  return result;
}

/** Fetch prices for a specific skin+source — uses cache */
export function getPricesForSkin(skinId: string, stattrak: boolean, source: PriceSource): Map<Condition, number> {
  ensureCache();
  const st = stattrak ? 1 : 0;
  const map = new Map<Condition, number>();
  for (const cond of Object.values(Condition)) {
    const p = priceCache.get(`${skinId}:${cond}:${st}:${source}`);
    if (p) map.set(cond, p);
  }
  return map;
}

export function getPrice(skinId: string, condition: Condition, stattrak: boolean, source: PriceSource): number {
  ensureCache();
  return priceCache.get(`${skinId}:${condition}:${stattrak ? 1 : 0}:${source}`) ?? 0;
}
