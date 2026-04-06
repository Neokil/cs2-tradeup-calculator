#!/usr/bin/env node
// Load .env file before anything else
import fs from 'fs';
if (fs.existsSync('.env')) {
  for (const line of fs.readFileSync('.env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

import { Command } from 'commander';
import { syncCommand } from './cli/commands/sync.js';
import { scanCommand } from './cli/commands/scan.js';
import { watchCommand } from './cli/commands/watch.js';
import { createServer } from './web/server.js';
import { closeDb } from './db/client.js';

const program = new Command();

program
  .name('cs2-tradeup')
  .description('CS2 Trade-Up Calculator - Find the most profitable trade-up contracts')
  .version('1.0.0');

program
  .command('sync')
  .description('Sync skin data and prices from APIs')
  .option('--prices-only', 'Only refresh prices, skip collection sync')
  .option('--rarity <rarity>', 'Only sync a specific rarity tier')
  .action(async (options) => {
    try {
      await syncCommand(options);
    } catch (error) {
      console.error('Sync failed:', error);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

program
  .command('scan')
  .description('Scan for profitable trade-ups using cached prices')
  .option('--min-roi <percent>', 'Minimum ROI threshold (default: 5)')
  .option('--max-results <count>', 'Maximum results to show (default: 50)')
  .option('--format <type>', 'Output format: table or json (default: table)')
  .option('--stattrak', 'Search for StatTrak trade-ups')
  .action((options) => {
    try {
      scanCommand(options);
    } catch (error) {
      console.error('Scan failed:', error);
      process.exit(1);
    } finally {
      closeDb();
    }
  });

program
  .command('watch')
  .description('Run in watch mode - periodically refresh prices and scan')
  .option('--min-roi <percent>', 'Minimum ROI threshold')
  .action((options) => {
    watchCommand(options);
    // Keep process alive
    process.on('SIGINT', () => {
      console.log('\nShutting down...');
      closeDb();
      process.exit(0);
    });
  });

program
  .command('web')
  .description('Start the web UI server')
  .option('--port <port>', 'Port to listen on (default: 3000)')
  .action((options) => {
    const port = options.port ? parseInt(options.port) : undefined;
    createServer(port);
  });

program.parse();
