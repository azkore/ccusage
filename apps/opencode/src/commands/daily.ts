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

export const dailyCommand = define({
	name: 'daily',
	description: 'Show OpenCode token usage grouped by day',
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
		const showBreakdown = ctx.values.full === true;
		const since = typeof ctx.values.since === 'string' ? ctx.values.since.trim() : '';
		const until = typeof ctx.values.until === 'string' ? ctx.values.until.trim() : '';

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
				? JSON.stringify({ daily: [], totals: null })
				: 'No OpenCode usage data found.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		using fetcher = new LiteLLMPricingFetcher({ offline: false, logger });

		const entriesByDate = groupBy(
			filteredEntries,
			(entry) => entry.timestamp.toISOString().split('T')[0]!,
		);

		const dailyData: Array<{
			date: string;
			inputTokens: number;
			outputTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			totalCost: number;
			modelsUsed: string[];
			modelBreakdown: Record<string, ModelTokenData>;
		}> = [];

		for (const [date, dayEntries] of Object.entries(entriesByDate)) {
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let totalCost = 0;
			const modelsSet = new Set<string>();
			const modelBreakdown: Record<string, ModelTokenData> = {};

			for (const entry of dayEntries) {
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

			dailyData.push({
				date,
				inputTokens,
				outputTokens,
				cacheCreationTokens,
				cacheReadTokens,
				totalCost,
				modelsUsed: Array.from(modelsSet),
				modelBreakdown,
			});
		}

		dailyData.sort((a, b) => a.date.localeCompare(b.date));

		const totals = {
			inputTokens: dailyData.reduce((sum, d) => sum + d.inputTokens, 0),
			outputTokens: dailyData.reduce((sum, d) => sum + d.outputTokens, 0),
			cacheCreationTokens: dailyData.reduce((sum, d) => sum + d.cacheCreationTokens, 0),
			cacheReadTokens: dailyData.reduce((sum, d) => sum + d.cacheReadTokens, 0),
			totalCost: dailyData.reduce((sum, d) => sum + d.totalCost, 0),
		};

		if (jsonOutput) {
			// eslint-disable-next-line no-console
			console.log(
				JSON.stringify(
					{
						daily: dailyData,
						totals,
					},
					null,
					2,
				),
			);
			return;
		}

		// eslint-disable-next-line no-console
		console.log('\n📊 OpenCode Token Usage Report - Daily\n');

		const table: ResponsiveTable = new ResponsiveTable({
			head: ['Date', 'Models', 'Input', 'Output', 'Cache', 'Cost (USD)'],
			colAligns: ['left', 'left', 'right', 'right', 'right', 'right'],
			compactHead: ['Date', 'Models', 'Input', 'Output', 'Cost (USD)'],
			compactColAligns: ['left', 'left', 'right', 'right', 'right'],
			compactThreshold: 90,
			forceCompact: Boolean(ctx.values.compact),
			style: { head: ['cyan'] },
			dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
		});

		for (const data of dailyData) {
			const dayInput = data.inputTokens + data.cacheCreationTokens + data.cacheReadTokens;

			// Summary Row (no $/M rates — mixed models)
			table.push([
				pc.bold(data.date),
				pc.bold('Daily Total'),
				pc.bold(formatNumber(dayInput)),
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

			// Add separator after each day
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
