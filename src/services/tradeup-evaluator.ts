import { Skin, TradeUpInput, TradeUpOutput, TradeUpResult, CollectionAllocation } from '../models/types.js';
import { Rarity, Condition, CONDITION_FLOAT_RANGES, conditionMidFloat } from '../models/enums.js';
import { normalizeFloat, calculateOutputFloat } from './float-calculator.js';
import { floatToCondition } from '../models/enums.js';
import { getPrice } from './price-service.js';
import { getSkinsInCollection } from './data-sync.js';
import { config } from '../config.js';

/**
 * Float position within a condition's range.
 *
 * LOW  = 5th percentile of the condition range intersected with skin range.
 *        This produces the smallest normalized value → potentially better output condition.
 *        e.g. FT skins at float ~0.155 can produce MW or even FN output!
 *
 * MID  = midpoint (conservative estimate, current default)
 * HIGH = 95th percentile → worst-case output condition
 */
export type FloatPosition = 'low' | 'mid' | 'high';

export function inputFloatForPosition(
  condition: Condition,
  skinMinFloat: number,
  skinMaxFloat: number,
  position: FloatPosition
): number {
  const [condMin, condMax] = CONDITION_FLOAT_RANGES[condition];
  const effectiveMin = Math.max(condMin, skinMinFloat);
  const effectiveMax = Math.min(condMax, skinMaxFloat);

  if (effectiveMax <= effectiveMin) return effectiveMin;

  switch (position) {
    case 'low':  return effectiveMin + (effectiveMax - effectiveMin) * 0.05;
    case 'high': return effectiveMin + (effectiveMax - effectiveMin) * 0.95;
    case 'mid':
    default:     return (effectiveMin + effectiveMax) / 2;
  }
}

export interface EvaluateTradeUpOptions {
  floatPosition?: FloatPosition;
  statTrak?: boolean;
}

/**
 * Evaluate a trade-up given a set of collection allocations.
 *
 * floatPosition controls where within each input skin's condition range the float is assumed:
 *   'low'  → assumes buyers target the lowest possible float (e.g. FT near 0.15)
 *            This can yield MW or FN outputs from FT inputs — the profitable scenario!
 *   'mid'  → midpoint (default, conservative)
 *   'high' → worst-case float
 */
export function evaluateTradeUp(
  allocations: CollectionAllocation[],
  inputRarity: Rarity,
  cheapestInputs: Map<string, { skin: Skin; priceCents: number; condition: Condition }>,
  statTrak: boolean = false,
  floatPosition: FloatPosition = 'mid'
): TradeUpResult | null {
  const outputRarity = inputRarity + 1;
  const totalInputs = allocations.reduce((sum, a) => sum + a.count, 0);

  // Build inputs
  const inputs: TradeUpInput[] = [];
  let totalInputCostCents = 0;

  for (const alloc of allocations) {
    const cheapest = cheapestInputs.get(alloc.collectionId);
    if (!cheapest || cheapest.priceCents === 0) return null;

    for (let i = 0; i < alloc.count; i++) {
      // Use float position to set the estimated float within the condition range
      const estimatedFloat = inputFloatForPosition(
        cheapest.condition,
        cheapest.skin.minFloat,
        cheapest.skin.maxFloat,
        floatPosition
      );

      inputs.push({
        skin: cheapest.skin,
        condition: cheapest.condition,
        statTrak,
        priceCents: cheapest.priceCents,
        estimatedFloat,
      });
      totalInputCostCents += cheapest.priceCents;
    }
  }

  // Calculate outputs
  const outputs: TradeUpOutput[] = [];
  let evCents = 0;

  for (const alloc of allocations) {
    const outputSkins = getSkinsInCollection(alloc.collectionId, outputRarity as Rarity);
    if (outputSkins.length === 0) return null;

    const collectionProbability = alloc.count / totalInputs;
    const probPerSkin = collectionProbability / outputSkins.length;

    for (const outputSkin of outputSkins) {
      const outputFloat = calculateOutputFloat(inputs, outputSkin);
      const outputCondition = floatToCondition(outputFloat);
      const outputPrice = getPrice(outputSkin.id, outputCondition, statTrak);

      outputs.push({
        skin: outputSkin,
        probability: probPerSkin,
        estimatedFloat: outputFloat,
        condition: outputCondition,
        priceCents: outputPrice,
      });

      evCents += outputPrice * probPerSkin;
    }
  }

  const evAfterTax = Math.round(evCents * (1 - config.steamTaxRate));
  const profit = evAfterTax - totalInputCostCents;
  const roi = totalInputCostCents > 0 ? (profit / totalInputCostCents) * 100 : 0;

  return {
    inputs,
    outputs,
    totalInputCostCents,
    expectedValueCents: Math.round(evCents),
    expectedValueAfterTaxCents: evAfterTax,
    expectedProfitCents: profit,
    roi,
    inputRarity,
    outputRarity: outputRarity as Rarity,
  };
}

/**
 * Evaluate a trade-up across all three float positions and return the best ROI.
 * This is the key function: finds cases like "FT inputs → MW/FN output" which are
 * far more profitable than "FT inputs → FT output".
 */
export function evaluateTradeUpBestFloat(
  allocations: CollectionAllocation[],
  inputRarity: Rarity,
  cheapestInputs: Map<string, { skin: Skin; priceCents: number; condition: Condition }>,
  statTrak: boolean = false
): (TradeUpResult & { floatPosition: FloatPosition }) | null {
  let best: (TradeUpResult & { floatPosition: FloatPosition }) | null = null;

  for (const pos of ['low', 'mid', 'high'] as FloatPosition[]) {
    const result = evaluateTradeUp(allocations, inputRarity, cheapestInputs, statTrak, pos);
    if (result && (!best || result.roi > best.roi)) {
      best = { ...result, floatPosition: pos };
    }
  }

  return best;
}
