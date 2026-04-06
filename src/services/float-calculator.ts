import { Skin, TradeUpInput } from '../models/types.js';
import { floatToCondition, Condition } from '../models/enums.js';

/**
 * October 2025 Trade-Up Float Formula (Normalized 0-1 Scale)
 *
 * 1. Normalize each input float to 0-1: (float - minFloat) / (maxFloat - minFloat)
 * 2. Average all normalized values
 * 3. Map to output range: outputFloat = (outMax - outMin) * avgNormalized + outMin
 */

export function normalizeFloat(float: number, minFloat: number, maxFloat: number): number {
  if (maxFloat === minFloat) return 0;
  return (float - minFloat) / (maxFloat - minFloat);
}

export function calculateOutputFloat(inputs: TradeUpInput[], outputSkin: Skin): number {
  if (inputs.length === 0) throw new Error('No inputs provided');

  let sumNormalized = 0;
  for (const input of inputs) {
    sumNormalized += normalizeFloat(
      input.estimatedFloat,
      input.skin.minFloat,
      input.skin.maxFloat
    );
  }

  const avgNormalized = sumNormalized / inputs.length;

  // Map to output skin's float range
  const outputFloat = (outputSkin.maxFloat - outputSkin.minFloat) * avgNormalized + outputSkin.minFloat;

  // Clamp to valid range
  return Math.max(outputSkin.minFloat, Math.min(outputSkin.maxFloat, outputFloat));
}

export function calculateOutputCondition(inputs: TradeUpInput[], outputSkin: Skin): {
  float: number;
  condition: Condition;
} {
  const float = calculateOutputFloat(inputs, outputSkin);
  return { float, condition: floatToCondition(float) };
}
