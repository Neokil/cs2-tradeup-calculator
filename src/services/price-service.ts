import { getDb } from '../db/client.js';
import { Skin, SkinPrice } from '../models/types.js';
import { Condition } from '../models/enums.js';
import { buildMarketHashName, fetchSteamPrice } from '../api/prices.js';

export function getCachedPrice(skinId: string, condition: Condition, statTrak: boolean): SkinPrice | null {
  const db = getDb();
  const row = db.prepare(
    'SELECT * FROM prices WHERE skin_id = ? AND condition = ? AND stattrak = ?'
  ).get(skinId, condition, statTrak ? 1 : 0) as any;

  if (!row) return null;
  return {
    skinId: row.skin_id,
    condition: row.condition as Condition,
    statTrak: row.stattrak === 1,
    priceCents: row.price_cents,
    volume: row.volume,
    updatedAt: row.updated_at,
  };
}

export function upsertPrice(price: SkinPrice): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO prices (skin_id, condition, stattrak, price_cents, volume, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(skin_id, condition, stattrak)
    DO UPDATE SET price_cents = excluded.price_cents, volume = excluded.volume, updated_at = excluded.updated_at
  `).run(price.skinId, price.condition, price.statTrak ? 1 : 0, price.priceCents, price.volume, price.updatedAt);
}

export async function fetchAndCachePrice(
  skin: Skin,
  condition: Condition,
  statTrak: boolean = false
): Promise<SkinPrice | null> {
  const marketHashName = buildMarketHashName(skin.weaponName, skin.patternName, condition, statTrak);
  const result = await fetchSteamPrice(marketHashName);

  if (!result) return null;

  const price: SkinPrice = {
    skinId: skin.id,
    condition,
    statTrak,
    priceCents: result.priceCents,
    volume: result.volume,
    updatedAt: Date.now(),
  };
  upsertPrice(price);
  return price;
}

export function getPrice(skinId: string, condition: Condition, statTrak: boolean = false): number {
  const cached = getCachedPrice(skinId, condition, statTrak);
  return cached?.priceCents ?? 0;
}

export function getAllPricesForSkin(skinId: string, statTrak: boolean = false): Map<Condition, number> {
  const db = getDb();
  const rows = db.prepare(
    'SELECT condition, price_cents FROM prices WHERE skin_id = ? AND stattrak = ?'
  ).all(skinId, statTrak ? 1 : 0) as any[];

  const map = new Map<Condition, number>();
  for (const row of rows) {
    map.set(row.condition as Condition, row.price_cents);
  }
  return map;
}
