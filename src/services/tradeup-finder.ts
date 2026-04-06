/**
 * Trade-Up Finder — finds profitable trade-up contracts.
 *
 * Core insight:
 *   The OUTPUT CONDITION of a trade-up depends on the input skins' FLOAT VALUES,
 *   not just their wear label. A Field-Tested skin bought at float ≈ 0.151 (the
 *   very bottom of the FT range) can produce a Minimal Wear or even Factory New
 *   output — at FT market price.
 *
 * Algorithm:
 *   For every rarity tier (input rarity R → output rarity R+1):
 *     For every combination of collections (1–2 collections, 10 skins total):
 *       For every condition combo (5^N combos for N allocations):
 *         For every skin selection from each collection:
 *           Calculate expected value. If ROI ≥ threshold → save result.
 *
 * Skin selection:
 *   Each skin in a collection at the same rarity has a DIFFERENT float range.
 *   We try every priced skin, since a skin with a lower float range will produce
 *   a lower normalized float → better output condition — even at the same input cost.
 *
 * For 1-collection allocations: try ALL priced skins.
 * For 2-collection allocations: try cheapest + lowest-normalized-float per allocation.
 */

import { Skin, TradeUpResult, TradeUpInput, TradeUpOutput, CollectionAllocation } from '../models/types.js';
import {
  Rarity, Condition, CONDITION_FLOAT_RANGES,
  floatToCondition,
} from '../models/enums.js';
import {
  getEligibleCollections, getSkinsInCollection,
  getCollectionName, getPricesForSkin, getPrice, getListings,
  getCasesWithKnives, CaseEntry,
} from './data-sync.js';
import { PriceSource } from '../api/bulk-prices.js';
import { normalizeFloat } from './float-calculator.js';
import { config } from '../config.js';

// ─────────────────────────────────────────────────────────────────
// Float helpers
// ─────────────────────────────────────────────────────────────────

export type FloatMode = 'mid' | 'below_avg' | 'low';
const FLOAT_MODE_PCT: Record<FloatMode, number> = { mid: 0.50, below_avg: 0.25, low: 0.10 };

/** Minimum active listings required for an OUTPUT skin to contribute to EV.
 *  Skins with fewer listings have unreliable/artificial prices that can't be sold at scale. */
const MIN_OUTPUT_LISTINGS = 3;

function targetFloat(condition: Condition, skinMin: number, skinMax: number, position: FloatMode): number {
  const [cMin, cMax] = CONDITION_FLOAT_RANGES[condition];
  const effMin = Math.max(cMin, skinMin);
  const effMax = Math.min(cMax, skinMax);
  if (effMax <= effMin) return effMin;
  return effMin + (effMax - effMin) * FLOAT_MODE_PCT[position];
}

function outputFloatForInput(avgNormalized: number, outputSkin: Skin): number {
  const raw = (outputSkin.maxFloat - outputSkin.minFloat) * avgNormalized + outputSkin.minFloat;
  return Math.max(outputSkin.minFloat, Math.min(outputSkin.maxFloat, raw));
}

function averageNormalized(inputs: Array<{ skinMin: number; skinMax: number; float: number }>): number {
  let sum = 0;
  for (const inp of inputs) sum += normalizeFloat(inp.float, inp.skinMin, inp.skinMax);
  return sum / inputs.length;
}

export function requiredMaxFloat(
  inputSkin: Skin, inputCondition: Condition,
  outputSkin: Skin, targetOutputCondition: Condition,
): number | null {
  const [, outCondMax] = CONDITION_FLOAT_RANGES[targetOutputCondition];
  const normThreshold = (outCondMax - outputSkin.minFloat) / (outputSkin.maxFloat - outputSkin.minFloat);
  if (normThreshold <= 0) return null;
  const maxFloat = normThreshold * (inputSkin.maxFloat - inputSkin.minFloat) + inputSkin.minFloat;
  const [condMin, condMax] = CONDITION_FLOAT_RANGES[inputCondition];
  const effMax = Math.min(condMax, inputSkin.maxFloat);
  if (maxFloat <= Math.max(condMin, inputSkin.minFloat)) return null;
  return Math.min(maxFloat, effMax);
}

// ─────────────────────────────────────────────────────────────────
// Collection allocation generator
// ─────────────────────────────────────────────────────────────────

function* generateAllocations(
  collectionIds: string[], total: number, maxCollections = 2,
): Generator<CollectionAllocation[]> {
  const n = collectionIds.length;
  for (let i = 0; i < n; i++)
    yield [{ collectionId: collectionIds[i], count: total }];
  if (maxCollections < 2) return;
  for (let i = 0; i < n - 1; i++)
    for (let j = i + 1; j < n; j++)
      for (let a = 1; a < total; a++)
        yield [{ collectionId: collectionIds[i], count: a }, { collectionId: collectionIds[j], count: total - a }];
}

// ─────────────────────────────────────────────────────────────────
// Skin selection helpers
// ─────────────────────────────────────────────────────────────────

function getPricedSkinsFor(
  collectionId: string, rarity: Rarity, condition: Condition,
  statTrak: boolean, source: PriceSource,
): Skin[] {
  return getSkinsInCollection(collectionId, rarity)
    .filter(s => getPrice(s.id, condition, statTrak, source) > 0);
}

function candidateSkins(
  collectionId: string, rarity: Rarity, condition: Condition,
  statTrak: boolean, allSkins: boolean, floatMode: FloatMode, source: PriceSource,
): Skin[] {
  const skins = getPricedSkinsFor(collectionId, rarity, condition, statTrak, source);
  if (!skins.length) return [];
  if (allSkins) return skins;
  const cheapest = skins.reduce((a, b) =>
    getPrice(a.id, condition, statTrak, source) <= getPrice(b.id, condition, statTrak, source) ? a : b
  );
  const lowestNorm = skins.reduce((a, b) => {
    const na = normalizeFloat(targetFloat(condition, a.minFloat, a.maxFloat, floatMode), a.minFloat, a.maxFloat);
    const nb = normalizeFloat(targetFloat(condition, b.minFloat, b.maxFloat, floatMode), b.minFloat, b.maxFloat);
    return na <= nb ? a : b;
  });
  const seen = new Map([[cheapest.id, cheapest], [lowestNorm.id, lowestNorm]]);
  return [...seen.values()];
}

function* cartesianSkins(groups: Skin[][]): Generator<Skin[]> {
  if (groups.length === 0) { yield []; return; }
  const [first, ...rest] = groups;
  for (const skin of first)
    for (const tail of cartesianSkins(rest))
      yield [skin, ...tail];
}

// ─────────────────────────────────────────────────────────────────
// Core evaluator
// ─────────────────────────────────────────────────────────────────

export interface EvaluatedTradeUp extends TradeUpResult {
  inputCondition: Condition;
  inputConditions: Condition[];
  inputFloat: number;
  floatMode: FloatMode;
  requiredFloatNote: string;
}

const ALL_CONDITIONS = Object.values(Condition);

function* conditionCombos(n: number): Generator<Condition[]> {
  if (n === 1) { for (const c of ALL_CONDITIONS) yield [c]; return; }
  for (const c of ALL_CONDITIONS)
    for (const rest of conditionCombos(n - 1))
      yield [c, ...rest];
}

function availableConditions(
  collectionId: string, rarity: Rarity, statTrak: boolean, source: PriceSource,
): Set<Condition> {
  const set = new Set<Condition>();
  for (const skin of getSkinsInCollection(collectionId, rarity))
    for (const [cond] of getPricesForSkin(skin.id, statTrak, source))
      set.add(cond);
  return set;
}

function evaluateWithSkins(
  allocations: CollectionAllocation[],
  inputRarity: Rarity,
  conditions: Condition[],
  skinSelection: Skin[],
  statTrak: boolean,
  floatMode: FloatMode = 'mid',
  source: PriceSource,
): EvaluatedTradeUp | null {
  const outputRarity = (inputRarity + 1) as Rarity;
  const total = allocations.reduce((s, a) => s + a.count, 0);

  const inputsByAlloc: Array<{
    collectionId: string; count: number; skin: Skin;
    condition: Condition; pricePerUnit: number; inputFloat: number;
  }> = [];

  for (let i = 0; i < allocations.length; i++) {
    const alloc = allocations[i];
    const cond = conditions[i];
    const skin = skinSelection[i];
    const price = getPrice(skin.id, cond, statTrak, source);
    if (price <= 0) return null;
    const inputFloat = targetFloat(cond, skin.minFloat, skin.maxFloat, floatMode);
    inputsByAlloc.push({
      collectionId: alloc.collectionId, count: alloc.count,
      skin, condition: cond, pricePerUnit: price, inputFloat,
    });
  }

  const flatInputs = inputsByAlloc.flatMap(ic =>
    Array.from({ length: ic.count }, () => ({
      skinMin: ic.skin.minFloat, skinMax: ic.skin.maxFloat, float: ic.inputFloat,
    }))
  );
  const avgNorm = averageNormalized(flatInputs);

  const inputs: TradeUpInput[] = inputsByAlloc.flatMap(ic =>
    Array.from({ length: ic.count }, () => ({
      skin: ic.skin, condition: ic.condition, statTrak,
      priceCents: ic.pricePerUnit, estimatedFloat: ic.inputFloat,
    }))
  );

  const totalInputCostCents = inputsByAlloc.reduce((s, ic) => s + ic.pricePerUnit * ic.count, 0);

  const outputs: TradeUpOutput[] = [];
  let evCents = 0;
  for (const alloc of allocations) {
    const outputSkins = getSkinsInCollection(alloc.collectionId, outputRarity);
    if (outputSkins.length === 0) return null;
    const probPerSkin = (alloc.count / total) / outputSkins.length;
    for (const outSkin of outputSkins) {
      const outFloat = outputFloatForInput(avgNorm, outSkin);
      const outCond = floatToCondition(outFloat);
      const outPrice = getPrice(outSkin.id, outCond, statTrak, source);
      const outListings = getListings(outSkin.id, outCond, statTrak, source);
      // Only count price toward EV if there are enough listings to be realistically sellable
      const evPrice = outListings >= MIN_OUTPUT_LISTINGS ? outPrice : 0;
      outputs.push({ skin: outSkin, probability: probPerSkin, estimatedFloat: outFloat, condition: outCond, priceCents: outPrice });
      evCents += evPrice * probPerSkin;
    }
  }

  const feeRate = source === 'csfloat' ? config.csfloatFeeRate : config.steamTaxRate;
  const evAfterTax = Math.round(evCents * (1 - feeRate));
  const profit = evAfterTax - totalInputCostCents;
  const roi = totalInputCostCents > 0 ? (profit / totalInputCostCents) * 100 : 0;

  const dominantAlloc = inputsByAlloc.reduce((a, b) => a.count >= b.count ? a : b);
  const usedFloat = dominantAlloc.inputFloat;
  const [dMin, dMax] = CONDITION_FLOAT_RANGES[dominantAlloc.condition];
  const effMin = Math.max(dMin, dominantAlloc.skin.minFloat);
  const effMax = Math.min(dMax, dominantAlloc.skin.maxFloat);
  const isMixed = new Set(conditions).size > 1;
  const isMixedSkins = new Set(inputsByAlloc.map(ic => ic.skin.id)).size > 1;
  const condLabel = isMixed
    ? inputsByAlloc.map(ic => `${ic.count}× ${ic.condition}`).join(' + ')
    : conditions[0];
  const skinLabel = isMixedSkins
    ? inputsByAlloc.map(ic => ic.skin.name.split('|')[1]?.trim() ?? ic.skin.name).join(' / ')
    : (inputsByAlloc[0].skin.name.split('|')[1]?.trim() ?? inputsByAlloc[0].skin.name);
  const requiredFloatNote = floatMode === 'low'
    ? `${condLabel} (${skinLabel}) — search float ≤ ${usedFloat.toFixed(3)}`
    : `${condLabel} (${skinLabel}) — avg ~${usedFloat.toFixed(3)} (${effMin.toFixed(3)}–${effMax.toFixed(3)})`;

  return {
    inputs, outputs, totalInputCostCents,
    expectedValueCents: Math.round(evCents),
    expectedValueAfterTaxCents: evAfterTax,
    expectedProfitCents: profit, roi, inputRarity, outputRarity,
    floatPosition: floatMode,
    inputCondition: dominantAlloc.condition, inputConditions: conditions,
    inputFloat: usedFloat, floatMode, requiredFloatNote,
  };
}

// ─────────────────────────────────────────────────────────────────
// Public: find profitable trade-ups
// ─────────────────────────────────────────────────────────────────

export interface FinderOptions {
  minRoi?: number;
  maxResults?: number;
  statTrak?: boolean;
  rarities?: Rarity[];
  floatMode?: FloatMode;
  priceSource?: PriceSource;
}

export function findProfitableTradeUps(options: FinderOptions = {}): EvaluatedTradeUp[] {
  const {
    minRoi = config.minRoiThreshold,
    maxResults = config.maxResults,
    statTrak = false,
    rarities = [Rarity.IndustrialGrade, Rarity.MilSpec, Rarity.Restricted, Rarity.Classified],
    floatMode = 'mid',
    priceSource = 'csfloat',
  } = options;

  const results: EvaluatedTradeUp[] = [];
  let evaluated = 0;
  let pruned = 0;

  for (const inputRarity of rarities) {
    const outputRarity = (inputRarity + 1) as Rarity;
    const eligibleCollections = getEligibleCollections(inputRarity, priceSource);

    const withPrices = eligibleCollections.filter(cid => {
      const hasInput = getSkinsInCollection(cid, inputRarity).some(s =>
        getPricesForSkin(s.id, statTrak, priceSource).size > 0
      );
      const hasOutput = getSkinsInCollection(cid, outputRarity).some(s =>
        getPricesForSkin(s.id, statTrak, priceSource).size > 0
      );
      return hasInput && hasOutput;
    });

    if (withPrices.length === 0) {
      console.log(`  No priced collections for ${Rarity[inputRarity]} → skipping`);
      continue;
    }

    // Cap 2-collection combos: C(n,2)×9 allocations explodes past ~40 collections.
    // Above that threshold, only use single-collection trade-ups to stay within memory.
    const maxColls = withPrices.length > 40 ? 1 : 2;
    console.log(`${Rarity[inputRarity]} → ${Rarity[outputRarity]}: ${withPrices.length} eligible collections (maxColls=${maxColls})`);

    for (const allocations of generateAllocations(withPrices, 10, maxColls)) {
      const maxPossibleEv = upperBound(allocations, outputRarity, statTrak, priceSource);
      const minCost = lowerBound(allocations, inputRarity, statTrak, priceSource);
      const _feeRate = priceSource === 'csfloat' ? config.csfloatFeeRate : config.steamTaxRate;
      if (minCost === null || maxPossibleEv * (1 - _feeRate) < minCost) {
        pruned++;
        continue;
      }

      const avail = allocations.map(a => availableConditions(a.collectionId, inputRarity, statTrak, priceSource));
      const isSingleCollection = allocations.length === 1;

      for (const conditions of conditionCombos(allocations.length)) {
        if (!conditions.every((c, i) => avail[i].has(c))) continue;

        const skinGroups = allocations.map((a, i) =>
          candidateSkins(a.collectionId, inputRarity, conditions[i], statTrak, isSingleCollection, floatMode, priceSource)
        );
        if (skinGroups.some(g => g.length === 0)) continue;

        for (const skinSel of cartesianSkins(skinGroups)) {
          const result = evaluateWithSkins(allocations, inputRarity, conditions, skinSel, statTrak, floatMode, priceSource);
          evaluated++;
          if (result && result.roi >= minRoi) results.push(result);
        }
      }
    }
  }

  console.log(`Evaluated ${evaluated}, pruned ${pruned}, found ${results.length} profitable`);

  const seen = new Map<string, EvaluatedTradeUp>();
  for (const r of results) {
    const key = dedupeKey(r);
    const existing = seen.get(key);
    if (!existing || r.roi > existing.roi) seen.set(key, r);
  }
  const regularSorted = [...seen.values()]
    .sort((a, b) => b.roi - a.roi)
    .slice(0, maxResults);

  const caseResults = findProfitableCaseTradeUps(options);
  console.log(`Case-based knife/glove trade-ups found: ${caseResults.length}`);

  return [...regularSorted, ...caseResults];
}

function dedupeKey(r: EvaluatedTradeUp): string {
  const skinMap = new Map<string, { count: number; cond: Condition }>();
  for (const inp of r.inputs) {
    const k = `${inp.skin.id}:${inp.condition}`;
    const ex = skinMap.get(k);
    if (ex) ex.count++;
    else skinMap.set(k, { count: 1, cond: inp.condition });
  }
  const parts = [...skinMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([k, { count }]) => `${k}×${count}`);
  return `${r.inputRarity}:${parts.join(',')}`;
}

// ─────────────────────────────────────────────────────────────────
// Case-based 5-Covert → knife/glove scanner
// ─────────────────────────────────────────────────────────────────

function evaluateCaseTradeUp(
  crateId: string,
  entry: CaseEntry,
  condition: Condition,
  statTrak: boolean,
  floatMode: FloatMode,
  source: PriceSource,
): EvaluatedTradeUp | null {
  const { covertSkins, outputSkins } = entry;
  const CONTRACT_SIZE = 5;

  const pricedInputs = covertSkins.filter(s => getPrice(s.id, condition, statTrak, source) > 0);
  if (!pricedInputs.length) return null;

  const inputSkin = pricedInputs.reduce((a, b) =>
    getPrice(a.id, condition, statTrak, source) <= getPrice(b.id, condition, statTrak, source) ? a : b
  );
  const inputPrice = getPrice(inputSkin.id, condition, statTrak, source);
  const inputFloat = targetFloat(condition, inputSkin.minFloat, inputSkin.maxFloat, floatMode);
  const inputNorm = normalizeFloat(inputFloat, inputSkin.minFloat, inputSkin.maxFloat);
  const totalInputCostCents = inputPrice * CONTRACT_SIZE;

  const inputs: TradeUpInput[] = Array.from({ length: CONTRACT_SIZE }, () => ({
    skin: inputSkin, condition, statTrak,
    priceCents: inputPrice, estimatedFloat: inputFloat,
  }));

  const outputs: TradeUpOutput[] = [];
  let evCents = 0;
  const probPerSkin = 1 / outputSkins.length;

  for (const outSkin of outputSkins) {
    const outFloat = outputFloatForInput(inputNorm, outSkin);
    const outCond = floatToCondition(outFloat);
    const outPrice = getPrice(outSkin.id, outCond, statTrak, source);
    const outListings = getListings(outSkin.id, outCond, statTrak, source);
    const evPrice = outListings >= MIN_OUTPUT_LISTINGS ? outPrice : 0;
    outputs.push({ skin: outSkin, probability: probPerSkin, estimatedFloat: outFloat, condition: outCond, priceCents: outPrice });
    evCents += evPrice * probPerSkin;
  }

  if (outputs.length === 0) return null;

  const feeRate = source === 'csfloat' ? config.csfloatFeeRate : config.steamTaxRate;
  const evAfterTax = Math.round(evCents * (1 - feeRate));
  const profit = evAfterTax - totalInputCostCents;
  const roi = totalInputCostCents > 0 ? (profit / totalInputCostCents) * 100 : 0;

  const [dMin, dMax] = CONDITION_FLOAT_RANGES[condition];
  const effMin = Math.max(dMin, inputSkin.minFloat);
  const effMax = Math.min(dMax, inputSkin.maxFloat);
  const requiredFloatNote = floatMode === 'low'
    ? `${condition} (${inputSkin.patternName}) — search float ≤ ${inputFloat.toFixed(3)}`
    : `${condition} (${inputSkin.patternName}) — avg ~${inputFloat.toFixed(3)} (${effMin.toFixed(3)}–${effMax.toFixed(3)})`;

  return {
    inputs, outputs, totalInputCostCents,
    expectedValueCents: Math.round(evCents),
    expectedValueAfterTaxCents: evAfterTax,
    expectedProfitCents: profit, roi,
    inputRarity: Rarity.Covert, outputRarity: Rarity.Extraordinary,
    floatPosition: floatMode,
    inputCondition: condition, inputConditions: [condition],
    inputFloat, floatMode, requiredFloatNote,
  };
}

function findProfitableCaseTradeUps(options: FinderOptions): EvaluatedTradeUp[] {
  const { maxResults = 50, statTrak = false, floatMode = 'mid', priceSource = 'csfloat' } = options;
  const minRoi = -Infinity;
  const results: EvaluatedTradeUp[] = [];
  const casesMap = getCasesWithKnives();

  for (const [crateId, entry] of casesMap) {
    if (!entry.outputSkins.length) continue;
    const availConds = new Set<Condition>();
    for (const skin of entry.covertSkins)
      for (const [cond] of getPricesForSkin(skin.id, statTrak, priceSource))
        availConds.add(cond);

    for (const cond of availConds) {
      const result = evaluateCaseTradeUp(crateId, entry, cond, statTrak, floatMode, priceSource);
      if (result && result.roi >= minRoi) results.push(result);
    }
  }

  return results.sort((a, b) => b.roi - a.roi).slice(0, maxResults);
}

function upperBound(
  allocations: CollectionAllocation[], outputRarity: Rarity,
  statTrak: boolean, source: PriceSource,
): number {
  let maxEv = 0;
  const total = allocations.reduce((s, a) => s + a.count, 0);
  for (const alloc of allocations) {
    const outputs = getSkinsInCollection(alloc.collectionId, outputRarity);
    const collProb = alloc.count / total;
    let maxPrice = 0;
    for (const skin of outputs)
      for (const [, price] of getPricesForSkin(skin.id, statTrak, source))
        maxPrice = Math.max(maxPrice, price);
    maxEv += maxPrice * collProb;
  }
  return maxEv;
}

function lowerBound(
  allocations: CollectionAllocation[], inputRarity: Rarity,
  statTrak: boolean, source: PriceSource,
): number | null {
  let totalMin = 0;
  for (const alloc of allocations) {
    const skins = getSkinsInCollection(alloc.collectionId, inputRarity);
    let minPrice = Infinity;
    for (const skin of skins)
      for (const [, price] of getPricesForSkin(skin.id, statTrak, source))
        minPrice = Math.min(minPrice, price);
    if (minPrice === Infinity) return null;
    totalMin += minPrice * alloc.count;
  }
  return totalMin;
}
