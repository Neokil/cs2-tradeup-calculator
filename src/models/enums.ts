export enum Rarity {
  ConsumerGrade = 0,
  IndustrialGrade = 1,
  MilSpec = 2,
  Restricted = 3,
  Classified = 4,
  Covert = 5,
  /**
   * Extraordinary — knives and gloves (★).
   * In CS2 these are NOT reachable through the standard 10-skin trade-up contract.
   * They can appear as trade-up outputs only when a collection explicitly contains
   * both Covert weapon skins AND Extraordinary knife/glove skins (rare, mostly
   * older CS:GO operation collections). The ByMykel API uses 'rarity_ancient'
   * (no _weapon suffix) for gloves and some knives.
   */
  Extraordinary = 6,
}

export const RARITY_NAMES: Record<Rarity, string> = {
  [Rarity.ConsumerGrade]: 'Consumer Grade',
  [Rarity.IndustrialGrade]: 'Industrial Grade',
  [Rarity.MilSpec]: 'Mil-Spec',
  [Rarity.Restricted]: 'Restricted',
  [Rarity.Classified]: 'Classified',
  [Rarity.Covert]: 'Covert',
  [Rarity.Extraordinary]: 'Extraordinary',
};

// Maps ByMykel API rarity IDs to our enum
export const RARITY_FROM_API: Record<string, Rarity> = {
  'rarity_common_weapon':    Rarity.ConsumerGrade,
  'rarity_uncommon_weapon':  Rarity.IndustrialGrade,
  'rarity_rare_weapon':      Rarity.MilSpec,
  'rarity_mythical_weapon':  Rarity.Restricted,
  'rarity_legendary_weapon': Rarity.Classified,
  'rarity_ancient_weapon':   Rarity.Covert,
  // Knives and gloves use 'rarity_ancient' (without _weapon suffix) in the ByMykel API
  'rarity_ancient':          Rarity.Extraordinary,
};

export enum Condition {
  FactoryNew = 'Factory New',
  MinimalWear = 'Minimal Wear',
  FieldTested = 'Field-Tested',
  WellWorn = 'Well-Worn',
  BattleScarred = 'Battle-Scarred',
}

export const CONDITION_FLOAT_RANGES: Record<Condition, [number, number]> = {
  [Condition.FactoryNew]: [0.00, 0.07],
  [Condition.MinimalWear]: [0.07, 0.15],
  [Condition.FieldTested]: [0.15, 0.38],
  [Condition.WellWorn]: [0.38, 0.45],
  [Condition.BattleScarred]: [0.45, 1.00],
};

export function floatToCondition(float: number): Condition {
  if (float < 0.07) return Condition.FactoryNew;
  if (float < 0.15) return Condition.MinimalWear;
  if (float < 0.38) return Condition.FieldTested;
  if (float < 0.45) return Condition.WellWorn;
  return Condition.BattleScarred;
}

export function conditionMidFloat(condition: Condition, minFloat: number, maxFloat: number): number {
  const [condMin, condMax] = CONDITION_FLOAT_RANGES[condition];
  const effectiveMin = Math.max(condMin, minFloat);
  const effectiveMax = Math.min(condMax, maxFloat);
  return (effectiveMin + effectiveMax) / 2;
}
