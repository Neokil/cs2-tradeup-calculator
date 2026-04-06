import chalk from 'chalk';
import Table from 'cli-table3';
import { TradeUpResult } from '../models/types.js';
import { RARITY_NAMES, Rarity } from '../models/enums.js';
import { getCollectionName } from '../services/data-sync.js';

function centsToUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function colorRoi(roi: number): string {
  const str = `${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`;
  if (roi >= 20) return chalk.green.bold(str);
  if (roi >= 10) return chalk.green(str);
  if (roi >= 0) return chalk.yellow(str);
  return chalk.red(str);
}

export function formatTradeUpResult(result: TradeUpResult, rank: number): string {
  const lines: string[] = [];
  const inputRarityName = RARITY_NAMES[result.inputRarity] ?? 'Unknown';
  const outputRarityName = RARITY_NAMES[result.outputRarity] ?? 'Unknown';

  lines.push(
    chalk.bold(`#${rank}  ROI: ${colorRoi(result.roi)}  |  `) +
    `Profit: ${chalk.green(centsToUsd(result.expectedProfitCents))}  |  ` +
    `EV: ${centsToUsd(result.expectedValueAfterTaxCents)}  |  ` +
    `Cost: ${centsToUsd(result.totalInputCostCents)}`
  );
  lines.push(chalk.dim('─'.repeat(70)));

  // Group inputs by skin
  lines.push(chalk.bold(`INPUTS (${inputRarityName} → ${outputRarityName}):`));
  const inputGroups = new Map<string, { skin: typeof result.inputs[0]; count: number }>();
  for (const input of result.inputs) {
    const key = `${input.skin.id}:${input.condition}`;
    const existing = inputGroups.get(key);
    if (existing) {
      existing.count++;
    } else {
      inputGroups.set(key, { skin: input, count: 1 });
    }
  }

  for (const [, { skin: input, count }] of inputGroups) {
    const colName = getCollectionName(input.skin.collectionId);
    lines.push(
      `  ${count}x  ${input.skin.name} (${input.condition})` +
      chalk.dim(`  ${centsToUsd(input.priceCents)} ea   [${colName}]`)
    );
  }
  lines.push(`  Total: ${chalk.bold(centsToUsd(result.totalInputCostCents))}`);

  // Outputs
  lines.push('');
  lines.push(chalk.bold('OUTPUTS:'));
  const sortedOutputs = [...result.outputs].sort((a, b) => b.probability - a.probability);
  for (const output of sortedOutputs) {
    const pct = (output.probability * 100).toFixed(0);
    const colName = getCollectionName(output.skin.collectionId);
    const priceStr = output.priceCents > 0 ? centsToUsd(output.priceCents) : chalk.red('no price');
    lines.push(
      `  ${pct.padStart(3)}% → ${output.skin.name} (${output.condition})` +
      chalk.dim(`  ${priceStr}  [${colName}]`)
    );
  }

  lines.push('');
  lines.push(
    `  EV (after ${(config_steamTaxRate() * 100).toFixed(0)}% tax): ${chalk.bold(centsToUsd(result.expectedValueAfterTaxCents))}  |  ` +
    `Net Profit: ${chalk.bold.green(centsToUsd(result.expectedProfitCents))}`
  );

  return lines.join('\n');
}

function config_steamTaxRate(): number {
  return 0.13;
}

export function formatResultsTable(results: TradeUpResult[]): string {
  if (results.length === 0) {
    return chalk.yellow('No profitable trade-ups found. Try syncing more prices or lowering the ROI threshold.');
  }

  const lines: string[] = [];
  lines.push('');
  lines.push(chalk.bold.cyan('═══════════════════════════════════════════════════════════════════'));
  lines.push(chalk.bold.cyan(`  CS2 Trade-Up Calculator - ${results.length} Profitable Trade-Ups Found`));
  lines.push(chalk.bold.cyan('═══════════════════════════════════════════════════════════════════'));
  lines.push('');

  for (let i = 0; i < results.length; i++) {
    lines.push(formatTradeUpResult(results[i], i + 1));
    lines.push('');
  }

  return lines.join('\n');
}

export function formatResultsJson(results: TradeUpResult[]): string {
  return JSON.stringify(results.map(r => ({
    roi: r.roi,
    profitUsd: r.expectedProfitCents / 100,
    evUsd: r.expectedValueAfterTaxCents / 100,
    costUsd: r.totalInputCostCents / 100,
    inputRarity: RARITY_NAMES[r.inputRarity],
    outputRarity: RARITY_NAMES[r.outputRarity],
    inputs: r.inputs.map(i => ({
      name: i.skin.name,
      condition: i.condition,
      priceUsd: i.priceCents / 100,
    })),
    outputs: r.outputs.map(o => ({
      name: o.skin.name,
      condition: o.condition,
      probability: o.probability,
      priceUsd: o.priceCents / 100,
    })),
  })), null, 2);
}
