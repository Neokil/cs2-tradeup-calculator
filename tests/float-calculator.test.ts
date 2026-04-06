import { describe, it, expect } from 'vitest';
import { normalizeFloat, calculateOutputFloat } from '../src/services/float-calculator.js';
import { Rarity, Condition } from '../src/models/enums.js';
import { TradeUpInput, Skin } from '../src/models/types.js';

describe('normalizeFloat', () => {
  it('should normalize to 0 at min float', () => {
    expect(normalizeFloat(0.0, 0.0, 1.0)).toBe(0);
  });

  it('should normalize to 1 at max float', () => {
    expect(normalizeFloat(1.0, 0.0, 1.0)).toBe(1);
  });

  it('should normalize to 0.5 at midpoint', () => {
    expect(normalizeFloat(0.5, 0.0, 1.0)).toBe(0.5);
  });

  it('should handle capped float ranges', () => {
    // M4A1-S Knight has range [0.0, 0.08]
    const result = normalizeFloat(0.04, 0.0, 0.08);
    expect(result).toBe(0.5);
  });

  it('should handle equal min and max', () => {
    expect(normalizeFloat(0.5, 0.5, 0.5)).toBe(0);
  });
});

describe('calculateOutputFloat', () => {
  const makeSkin = (minFloat: number, maxFloat: number): Skin => ({
    id: 'test',
    name: 'Test Skin',
    weaponName: 'AK-47',
    patternName: 'Test',
    rarity: Rarity.Restricted,
    minFloat,
    maxFloat,
    hasStatTrak: false,
    collectionId: 'col-1',
  });

  const makeInput = (estimatedFloat: number, minFloat: number, maxFloat: number): TradeUpInput => ({
    skin: makeSkin(minFloat, maxFloat),
    condition: Condition.FieldTested,
    statTrak: false,
    priceCents: 100,
    estimatedFloat,
  });

  it('should calculate output float with uniform inputs', () => {
    // 10 inputs all at midpoint of [0, 1] range
    const inputs = Array.from({ length: 10 }, () => makeInput(0.5, 0.0, 1.0));
    const outputSkin = makeSkin(0.0, 1.0);

    const result = calculateOutputFloat(inputs, outputSkin);
    expect(result).toBeCloseTo(0.5, 5);
  });

  it('should map to output range correctly', () => {
    // All inputs normalized to 0.5, output skin range [0.0, 0.5]
    const inputs = Array.from({ length: 10 }, () => makeInput(0.5, 0.0, 1.0));
    const outputSkin = makeSkin(0.0, 0.5);

    const result = calculateOutputFloat(inputs, outputSkin);
    expect(result).toBeCloseTo(0.25, 5);
  });

  it('should handle mixed input float ranges (Oct 2025 normalization)', () => {
    // This is the key test: skins with different float ranges
    // Knight [0, 0.08] at float 0.04 → normalized 0.5
    // Vulcan [0, 1.0] at float 0.3 → normalized 0.3
    const inputs = [
      ...Array.from({ length: 5 }, () => makeInput(0.04, 0.0, 0.08)),
      ...Array.from({ length: 5 }, () => makeInput(0.3, 0.0, 1.0)),
    ];

    const outputSkin = makeSkin(0.0, 1.0);
    const result = calculateOutputFloat(inputs, outputSkin);

    // Expected: (5*0.5 + 5*0.3) / 10 = 0.4
    expect(result).toBeCloseTo(0.4, 5);
  });

  it('should clamp to output skin range', () => {
    // All inputs at max float → normalized 1.0
    const inputs = Array.from({ length: 10 }, () => makeInput(1.0, 0.0, 1.0));
    const outputSkin = makeSkin(0.06, 0.8);

    const result = calculateOutputFloat(inputs, outputSkin);
    expect(result).toBeLessThanOrEqual(0.8);
    expect(result).toBeGreaterThanOrEqual(0.06);
  });
});
