import type { ComponentCosts, ModelTokenData } from '../cost-utils.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import {
	addEmptySeparatorRow,
	formatCurrency,
	formatNumber,
	ResponsiveTable,
} from '@ccusage/terminal/table';
import { groupBy } from 'es-toolkit';
import { define } from 'gunshi';
import pc from 'picocolors';
import {
	calculateComponentCosts,
	calculateCostForEntry,
	formatAggregateCacheColumn,
	formatCacheColumn,
	formatInputColumn,
	formatOutputColumn,
	totalInputTokens,
} from '../cost-utils.ts';
import { loadOpenCodeMessages } from '../data-loader.ts';
import { logger } from '../logger.ts';

const TABLE_COLUMN_COUNT = 5;

export const modelCommand = define({
	name: 'model',
	description: 'Show OpenCode token usage grouped by model',
	args: {
		json: {
			type: 'boolean',
			short: 'j',
			description: 'Output in JSON format',
		},
		compact: {
			type: 'boolean',
			description: 'Force compact table mode',
		},
	},
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);

		const entries = await loadOpenCodeMessages();

		if (entries.length === 0) {
			const output = jsonOutput
				? JSON.stringify({ models: [], totals: null })
				: 'No OpenCode usage data found.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		using fetcher = new LiteLLMPricingFetcher({ offline: false, logger });

		const entriesByModel = groupBy(entries, (entry) => entry.model);

		const modelData: Array<
			ModelTokenData & {
				model: string;
				componentCosts: ComponentCosts;
			}
		> = [];

		for (const [model, modelEntries] of Object.entries(entriesByModel)) {
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let totalCost = 0;

			for (const entry of modelEntries) {
				const cost = await calculateCostForEntry(entry, fetcher);
				inputTokens += entry.usage.inputTokens;
				outputTokens += entry.usage.outputTokens;
				cacheCreationTokens += entry.usage.cacheCreationInputTokens;
				cacheReadTokens += entry.usage.cacheReadInputTokens;
				totalCost += cost;
			}

			const componentCosts = await calculateComponentCosts(
				{ inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens },
				model,
				fetcher,
			);

			modelData.push({
				model,
				inputTokens,
				outputTokens,
				cacheCreationTokens,
				cacheReadTokens,
				totalCost,
				componentCosts,
			});
		}

		// Sort by total cost descending
		modelData.sort((a, b) => b.totalCost - a.totalCost);

		const totals = {
			inputTokens: modelData.reduce((sum, d) => sum + d.inputTokens, 0),
			outputTokens: modelData.reduce((sum, d) => sum + d.outputTokens, 0),
			cacheCreationTokens: modelData.reduce((sum, d) => sum + d.cacheCreationTokens, 0),
			cacheReadTokens: modelData.reduce((sum, d) => sum + d.cacheReadTokens, 0),
			totalCost: modelData.reduce((sum, d) => sum + d.totalCost, 0),
		};

		if (jsonOutput) {
			// eslint-disable-next-line no-console
			console.log(
				JSON.stringify(
					{
						models: modelData.map((d) => ({
							model: d.model,
							inputTokens: totalInputTokens(d),
							outputTokens: d.outputTokens,
							cacheReadTokens: d.cacheReadTokens,
							totalCost: d.totalCost,
						})),
						totals: {
							inputTokens: totals.inputTokens + totals.cacheCreationTokens + totals.cacheReadTokens,
							outputTokens: totals.outputTokens,
							cacheReadTokens: totals.cacheReadTokens,
							totalCost: totals.totalCost,
						},
					},
					null,
					2,
				),
			);
			return;
		}

		// eslint-disable-next-line no-console
		console.log('\n📊 OpenCode Token Usage Report - By Model\n');

		const table: ResponsiveTable = new ResponsiveTable({
			head: ['Model', 'Input', 'Output', 'Cache', 'Cost (USD)'],
			colAligns: ['left', 'right', 'right', 'right', 'right'],
			compactHead: ['Model', 'Input', 'Output', 'Cost (USD)'],
			compactColAligns: ['left', 'right', 'right', 'right'],
			compactThreshold: 80,
			forceCompact: Boolean(ctx.values.compact),
			style: { head: ['cyan'] },
		});

		for (const data of modelData) {
			table.push([
				pc.bold(data.model),
				formatInputColumn(data, data.componentCosts),
				formatOutputColumn(data, data.componentCosts),
				formatCacheColumn(data),
				formatCurrency(data.totalCost),
			]);
		}

		addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);

		const totalInput = totals.inputTokens + totals.cacheCreationTokens + totals.cacheReadTokens;
		table.push([
			pc.yellow('Total'),
			pc.yellow(formatNumber(totalInput)),
			pc.yellow(formatNumber(totals.outputTokens)),
			pc.yellow(
				formatAggregateCacheColumn(
					totals.inputTokens,
					totals.cacheCreationTokens,
					totals.cacheReadTokens,
				),
			),
			pc.yellow(formatCurrency(totals.totalCost)),
		]);

		// eslint-disable-next-line no-console
		console.log(table.toString());

		if (table.isCompactMode()) {
			// eslint-disable-next-line no-console
			console.log('\nRunning in Compact Mode');
			// eslint-disable-next-line no-console
			console.log('Expand terminal width to see cache metrics');
		}
	},
});
