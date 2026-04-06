import { Rarity, Condition } from './enums.js';

export interface Collection {
  id: string;
  name: string;
  image?: string;
}

export interface Skin {
  id: string;
  name: string;
  weaponName: string;
  patternName: string;
  rarity: Rarity;
  minFloat: number;
  maxFloat: number;
  hasStatTrak: boolean;
  collectionId: string;
  defIndex?: number;   // CS2 weapon def_index (for CSFloat search URLs)
  paintIndex?: number; // CS2 paint_index (for CSFloat search URLs, per-phase for Doppler)
}

export interface SkinPrice {
  skinId: string;
  condition: Condition;
  statTrak: boolean;
  priceCents: number;
  volume: number;
  updatedAt: number; // unix timestamp
}

export interface TradeUpInput {
  skin: Skin;
  condition: Condition;
  statTrak: boolean;
  priceCents: number;
  estimatedFloat: number;
}

export interface TradeUpOutput {
  skin: Skin;
  probability: number;
  estimatedFloat: number;
  condition: Condition;
  priceCents: number;
}

export interface TradeUpResult {
  inputs: TradeUpInput[];
  outputs: TradeUpOutput[];
  totalInputCostCents: number;
  expectedValueCents: number;
  expectedValueAfterTaxCents: number;
  expectedProfitCents: number;
  roi: number; // percentage
  inputRarity: Rarity;
  outputRarity: Rarity;
  floatPosition?: 'low' | 'below_avg' | 'mid' | 'high'; // which float scenario produced this result
}

export interface CollectionAllocation {
  collectionId: string;
  count: number; // how many of the 10 inputs come from this collection
}
