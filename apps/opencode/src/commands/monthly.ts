import type { ComponentCosts, ModelTokenData } from '../cost-utils.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import {
	addEmptySeparatorRow,
	formatCurrency,
	formatDateCompact,
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
} from '../cost-utils.ts';
import { loadOpenCodeMessages } from '../data-loader.ts';
import { logger } from '../logger.ts';

const TABLE_COLUMN_COUNT = 6;

function isValidDateArg(value: string): boolean {
	return /^\d{8}$/.test(value);
}

function toEntryDateKey(date: Date): string {
	return date.toISOString().slice(0, 10).replace(/-/g, '');
}

export const monthlyCommand = define({
	name: 'monthly',
	description: 'Show OpenCode token usage grouped by month',
	args: {
		since: {
			type: 'string',
			description: 'Filter from date (YYYYMMDD format)',
		},
		until: {
			type: 'string',
			description: 'Filter until date (YYYYMMDD format)',
		},
		json: {
			type: 'boolean',
			short: 'j',
			description: 'Output in JSON format',
		},
		compact: {
			type: 'boolean',
			description: 'Force compact table mode',
		},
		full: {
			type: 'boolean',
			description: 'Show per-model breakdown rows',
		},
	},
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);
		const since = typeof ctx.values.since === 'string' ? ctx.values.since.trim() : '';
		const until = typeof ctx.values.until === 'string' ? ctx.values.until.trim() : '';
		const showBreakdown = ctx.values.full === true;

		if (since !== '' && !isValidDateArg(since)) {
			throw new Error(`Invalid --since value: ${since}. Use YYYYMMDD.`);
		}

		if (until !== '' && !isValidDateArg(until)) {
			throw new Error(`Invalid --until value: ${until}. Use YYYYMMDD.`);
		}

		if (since !== '' && until !== '' && since > until) {
			throw new Error('--since must be earlier than or equal to --until');
		}

		const entries = await loadOpenCodeMessages();
		const filteredEntries = entries.filter((entry) => {
			const dateKey = toEntryDateKey(entry.timestamp);
			if (since !== '' && dateKey < since) {
				return false;
			}
			if (until !== '' && dateKey > until) {
				return false;
			}
			return true;
		});

		if (filteredEntries.length === 0) {
			const output = jsonOutput
				? JSON.stringify({ monthly: [], totals: null })
				: 'No OpenCode usage data found.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		using fetcher = new LiteLLMPricingFetcher({ offline: false, logger });

		const entriesByMonth = groupBy(filteredEntries, (entry) =>
			entry.timestamp.toISOString().slice(0, 7),
		);

		const monthlyData: Array<{
			month: string;
			inputTokens: number;
			outputTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			totalCost: number;
			modelsUsed: string[];
			modelBreakdown: Record<string, ModelTokenData>;
		}> = [];

		for (const [month, monthEntries] of Object.entries(entriesByMonth)) {
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let totalCost = 0;
			const modelsSet = new Set<string>();
			const modelBreakdown: Record<string, ModelTokenData> = {};

			for (const entry of monthEntries) {
				const cost = await calculateCostForEntry(entry, fetcher);
				inputTokens += entry.usage.inputTokens;
				outputTokens += entry.usage.outputTokens;
				cacheCreationTokens += entry.usage.cacheCreationInputTokens;
				cacheReadTokens += entry.usage.cacheReadInputTokens;
				totalCost += cost;
				modelsSet.add(entry.model);

				let mb = modelBreakdown[entry.model];
				if (mb == null) {
					mb = {
						inputTokens: 0,
						outputTokens: 0,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						totalCost: 0,
					};
					modelBreakdown[entry.model] = mb;
				}
				mb.inputTokens += entry.usage.inputTokens;
				mb.outputTokens += entry.usage.outputTokens;
				mb.cacheCreationTokens += entry.usage.cacheCreationInputTokens;
				mb.cacheReadTokens += entry.usage.cacheReadInputTokens;
				mb.totalCost += cost;
			}

			monthlyData.push({
				month,
				inputTokens,
				outputTokens,
				cacheCreationTokens,
				cacheReadTokens,
				totalCost,
				modelsUsed: Array.from(modelsSet),
				modelBreakdown,
			});
		}

		monthlyData.sort((a, b) => a.month.localeCompare(b.month));

		const totals = {
			inputTokens: monthlyData.reduce((sum, d) => sum + d.inputTokens, 0),
			outputTokens: monthlyData.reduce((sum, d) => sum + d.outputTokens, 0),
			cacheCreationTokens: monthlyData.reduce((sum, d) => sum + d.cacheCreationTokens, 0),
			cacheReadTokens: monthlyData.reduce((sum, d) => sum + d.cacheReadTokens, 0),
			totalCost: monthlyData.reduce((sum, d) => sum + d.totalCost, 0),
		};

		if (jsonOutput) {
			// eslint-disable-next-line no-console
			console.log(
				JSON.stringify(
					{
						monthly: monthlyData,
						totals,
					},
					null,
					2,
				),
			);
			return;
		}

		// eslint-disable-next-line no-console
		console.log('\n📊 OpenCode Token Usage Report - Monthly\n');

		const table: ResponsiveTable = new ResponsiveTable({
			head: ['Month', 'Models', 'Input', 'Output', 'Cache', 'Cost (USD)'],
			colAligns: ['left', 'left', 'right', 'right', 'right', 'right'],
			compactHead: ['Month', 'Models', 'Input', 'Output', 'Cost (USD)'],
			compactColAligns: ['left', 'left', 'right', 'right', 'right'],
			compactThreshold: 90,
			forceCompact: Boolean(ctx.values.compact),
			style: { head: ['cyan'] },
			dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
		});

		for (const data of monthlyData) {
			const monthInput = data.inputTokens + data.cacheCreationTokens + data.cacheReadTokens;

			// Summary Row (no $/M rates — mixed models)
			table.push([
				pc.bold(data.month),
				pc.bold('Monthly Total'),
				pc.bold(formatNumber(monthInput)),
				pc.bold(formatNumber(data.outputTokens)),
				pc.bold(
					formatAggregateCacheColumn(
						data.inputTokens,
						data.cacheCreationTokens,
						data.cacheReadTokens,
					),
				),
				pc.bold(formatCurrency(data.totalCost)),
			]);

			if (showBreakdown) {
				// Breakdown Rows (per-model, with $/M rates)
				const sortedModels = Object.entries(data.modelBreakdown).sort(
					(a, b) => b[1].totalCost - a[1].totalCost,
				);

				for (const [model, metrics] of sortedModels) {
					const componentCosts: ComponentCosts = await calculateComponentCosts(
						metrics,
						model,
						fetcher,
					);

					table.push([
						'',
						pc.dim(`- ${model}`),
						formatInputColumn(metrics, componentCosts),
						formatOutputColumn(metrics, componentCosts),
						formatCacheColumn(metrics),
						pc.dim(formatCurrency(metrics.totalCost)),
					]);
				}
			}

			// Add separator after each month
			addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);
		}

		const totalInput = totals.inputTokens + totals.cacheCreationTokens + totals.cacheReadTokens;
		table.push([
			pc.yellow('Total'),
			'',
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
