import { config } from '../config.js';
import { Collection, Skin } from '../models/types.js';
import { Rarity, RARITY_FROM_API } from '../models/enums.js';

interface ApiCollectionSkin {
  id: string;
  name: string;
  rarity: { id: string; name: string };
  stattrak: boolean;
  paint_index: string | null;
}

interface ApiCollection {
  id: string;
  name: string;
  image: string | null;
  contains: ApiCollectionSkin[];
}

interface ApiSkinDetail {
  name: string;
  min_float: number;
  max_float: number;
}

interface FullApiSkin {
  id: string;
  name: string;
  min_float: number;
  max_float: number;
  rarity: { id: string; name: string };
  stattrak: boolean;
  souvenir?: boolean;
  weapon?: { id: string; weapon_id?: number; name: string };
  category?: { id: string; name: string };
  paint_index?: string | number | null;
  phase?: string | null;
}

interface ApiCrate {
  id: string;
  name: string;
  image: string | null;
  contains: ApiCollectionSkin[];
  contains_rare: ApiCollectionSkin[];
}

/** Synthetic collection IDs for the browse-only knife/glove pseudo-collections */
export const KNIFE_COLLECTION_ID = '__knives__';
export const GLOVE_COLLECTION_ID = '__gloves__';

export interface CrateData {
  /** One Collection entry per case that has a knife/glove rare pool */
  collections: Collection[];
  /**
   * Maps crate_id → Covert skin IDs for that case.
   * These skins already exist in the DB (from weapon collections).
   */
  caseCovertMap: Map<string, string[]>;
  /**
   * Maps crate_id → Extraordinary skin IDs in that case's rare pool.
   * These skins exist in __knives__ or __gloves__.
   */
  caseOutputMap: Map<string, string[]>;
}

async function fetchFloatRanges(): Promise<Map<string, { minFloat: number; maxFloat: number }>> {
  const url = `${config.csgoApiBase}/skins_not_grouped.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch skin details: ${res.status}`);
  const skins: ApiSkinDetail[] = await res.json();

  const map = new Map<string, { minFloat: number; maxFloat: number }>();
  const COND_SUFFIXES = [
    ' (Factory New)', ' (Minimal Wear)', ' (Field-Tested)', ' (Well-Worn)', ' (Battle-Scarred)'
  ];
  for (const s of skins) {
    if (s.min_float == null || s.max_float == null) continue;
    let baseName = s.name.replace(/^StatTrak™ /, '');
    for (const suf of COND_SUFFIXES) {
      if (baseName.endsWith(suf)) { baseName = baseName.slice(0, -suf.length); break; }
    }
    if (!map.has(baseName)) {
      map.set(baseName, { minFloat: s.min_float, maxFloat: s.max_float });
    }
  }
  return map;
}

export interface SkinIndexEntry {
  defIndex: number;
  paintIndex: number;
}

/** Fetch all knife/glove skins for the browse pseudo-collections.
 *  Also returns a map of skin_id → {defIndex, paintIndex} for ALL skins
 *  (used to build CSFloat search URLs), and a Set of limited-edition skin IDs
 *  that cannot be used in trade-up contracts. */
async function fetchKnivesAndGloves(): Promise<{
  collections: Collection[];
  skins: Skin[];
  skinIndexMap: Map<string, SkinIndexEntry>;
  limitedSkinIds: Set<string>;
}> {
  const url = `${config.csgoApiBase}/skins.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch skins.json: ${res.status}`);
  const allSkins: FullApiSkin[] = await res.json();

  const skins: Skin[] = [];
  const skinIndexMap = new Map<string, SkinIndexEntry>();
  const limitedSkinIds = new Set<string>();

  for (const s of allSkins) {
    // Build index map for ALL skins (not just knives/gloves)
    const defIndex = s.weapon?.weapon_id;
    const paintIndex = s.paint_index != null ? parseInt(String(s.paint_index), 10) : undefined;
    if (defIndex != null && paintIndex != null && !isNaN(paintIndex)) {
      // Only add once per skin_id (avoid duplicates from stattrak variants sharing same underlying skin)
      if (!skinIndexMap.has(s.id)) {
        skinIndexMap.set(s.id, { defIndex, paintIndex });
      }
    }

    const catId = s.category?.id;

    // Track Limited Edition skins — they come from Xbox/Prime/store rewards and
    // CANNOT be used in trade-up contracts (only regular weapon-collection skins can).
    if (catId === 'limited') {
      limitedSkinIds.add(s.id);
    }

    const isKnife = catId === 'sfui_invpanel_filter_melee';
    const isGlove = catId === 'sfui_invpanel_filter_gloves';
    if (!isKnife && !isGlove) continue;

    const parts = s.name.split(' | ');
    const weaponName = parts[0] ?? s.name;
    const patternName = parts[1] ?? '';
    if (!patternName) continue; // skip vanilla knives

    skins.push({
      id: s.id,
      name: s.name,
      weaponName,
      patternName,
      rarity: Rarity.Extraordinary,
      minFloat: s.min_float ?? 0.0,
      maxFloat: s.max_float ?? 1.0,
      hasStatTrak: s.stattrak,
      collectionId: isKnife ? KNIFE_COLLECTION_ID : GLOVE_COLLECTION_ID,
      defIndex,
      paintIndex,
    });
  }

  return {
    collections: [
      { id: KNIFE_COLLECTION_ID, name: '★ Knives', image: undefined },
      { id: GLOVE_COLLECTION_ID, name: '★ Gloves', image: undefined },
    ],
    skins,
    skinIndexMap,
    limitedSkinIds,
  };
}

/**
 * Fetch weapon case data and build:
 *  - A Collection for each crate with a knife/glove rare pool
 *  - caseCovertMap: crate_id → [covert skin IDs already in DB from weapon collections]
 *  - caseOutputMap: crate_id → [extraordinary skin IDs from __knives__ / __gloves__]
 *
 * Knife/glove skins are NOT added to the returned skins array — they already
 * exist in the DB via fetchKnivesAndGloves().
 */
export async function fetchCratesData(): Promise<CrateData> {
  const url = `${config.csgoApiBase}/crates.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch crates.json: ${res.status}`);
  const crates: ApiCrate[] = await res.json();

  const collections: Collection[] = [];
  const caseCovertMap = new Map<string, string[]>();
  const caseOutputMap = new Map<string, string[]>();

  for (const crate of crates) {
    if (!crate.contains_rare?.length) continue;

    const covertSkins = (crate.contains ?? []).filter(s => s.rarity.id === 'rarity_ancient_weapon');
    if (!covertSkins.length) continue;

    collections.push({
      id: crate.id,
      name: crate.name,
      image: crate.image ?? undefined,
    });

    // Covert skins already exist in weapon collections (same IDs confirmed by API check)
    caseCovertMap.set(crate.id, covertSkins.map(s => s.id));

    // Extraordinary skins: only patterned items (skip "★ Bayonet" vanilla entries)
    const outputIds = crate.contains_rare
      .filter(s => s.name.includes(' | '))
      .map(s => s.id);
    if (outputIds.length) {
      caseOutputMap.set(crate.id, outputIds);
    }
  }

  console.log(`Fetched ${collections.length} crates with knife/glove rare pools`);
  return { collections, caseCovertMap, caseOutputMap };
}

export async function fetchCollections(): Promise<{
  collections: Collection[];
  skins: Skin[];
  caseCovertMap: Map<string, string[]>;
  caseOutputMap: Map<string, string[]>;
}> {
  const url = `${config.csgoApiBase}/collections.json`;
  console.log(`Fetching collections from ${url}...`);

  const [response, floatRanges, knifeGloveData, crateData] = await Promise.all([
    fetch(url),
    fetchFloatRanges(),
    fetchKnivesAndGloves(),
    fetchCratesData(),
  ]);

  if (!response.ok) {
    throw new Error(`Failed to fetch collections: ${response.status} ${response.statusText}`);
  }

  const apiCollections: ApiCollection[] = await response.json();
  const collections: Collection[] = [];
  const skins: Skin[] = [];

  const { limitedSkinIds } = knifeGloveData;
  let skippedLimited = 0;

  for (const apiCol of apiCollections) {
    collections.push({ id: apiCol.id, name: apiCol.name, image: apiCol.image ?? undefined });

    for (const apiSkin of apiCol.contains) {
      if (!apiSkin.name.includes(' | ')) continue; // skip non-weapon items

      // Skip Limited Edition skins — they are Xbox/Prime/store rewards and cannot
      // be used in trade-up contracts (only regular weapon-collection skins can).
      if (limitedSkinIds.has(apiSkin.id)) {
        skippedLimited++;
        continue;
      }

      const rarity = RARITY_FROM_API[apiSkin.rarity.id];
      if (rarity === undefined) continue;

      const parts = apiSkin.name.split(' | ');
      const weaponName = parts[0] ?? apiSkin.name;
      const patternName = parts[1] ?? '';
      const floatData = floatRanges.get(apiSkin.name);
      const idx = knifeGloveData.skinIndexMap.get(apiSkin.id);

      skins.push({
        id: apiSkin.id,
        name: apiSkin.name,
        weaponName,
        patternName,
        rarity,
        minFloat: floatData?.minFloat ?? 0.0,
        maxFloat: floatData?.maxFloat ?? 1.0,
        hasStatTrak: apiSkin.stattrak,
        collectionId: apiCol.id,
        defIndex: idx?.defIndex,
        paintIndex: idx?.paintIndex,
      });
    }
  }

  if (skippedLimited > 0) {
    console.log(`Skipped ${skippedLimited} Limited Edition skins (not usable in trade-up contracts)`);
  }

  // Append knife/glove pseudo-collections (browse only, no trade-up routing here)
  collections.push(...knifeGloveData.collections);
  skins.push(...knifeGloveData.skins);

  // Append crate collection entries (display name for case trade-ups in the UI)
  // NO extra skins — knives/gloves are already in __knives__/__gloves__
  collections.push(...crateData.collections);

  console.log(`Fetched ${collections.length} collections with ${skins.length} skins`);
  return {
    collections,
    skins,
    caseCovertMap: crateData.caseCovertMap,
    caseOutputMap: crateData.caseOutputMap,
  };
}
