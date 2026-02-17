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
	calculateComponentCostsFromEntries,
	calculateCostForEntry,
	formatAggregateCachedInputColumn,
	formatAggregateUncachedInputColumn,
	formatCachedInputColumn,
	formatInputColumn,
	formatOutputColumn,
	formatOutputValueWithReasoningPct,
	formatUncachedInputColumn,
	totalInputTokens,
} from '../cost-utils.ts';
import { loadOpenCodeMessages, loadOpenCodeSessions } from '../data-loader.ts';
import { filterEntriesByDateRange, resolveDateRangeFilters } from '../date-filter.ts';
import { filterEntriesBySessionProjectFilters } from '../entry-filter.ts';
import { logger } from '../logger.ts';

const TABLE_COLUMN_COUNT = 6;

export const modelCommand = define({
	name: 'model',
	description: 'Show OpenCode token usage grouped by model',
	args: {
		id: {
			type: 'string',
			short: 'i',
			description: 'Filter to a specific session ID',
		},
		project: {
			type: 'string',
			short: 'p',
			description: 'Filter sessions by project name/path',
		},
		since: {
			type: 'string',
			description: 'Filter from date/time',
		},
		until: {
			type: 'string',
			description: 'Filter until date/time',
		},
		last: {
			type: 'string',
			description: 'Filter to recent duration (e.g. 15m, 2h, 3d, 1w)',
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
	},
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);
		const idInput = typeof ctx.values.id === 'string' ? ctx.values.id.trim() : '';
		const projectInput = typeof ctx.values.project === 'string' ? ctx.values.project.trim() : '';
		const sinceInput = typeof ctx.values.since === 'string' ? ctx.values.since.trim() : '';
		const untilInput = typeof ctx.values.until === 'string' ? ctx.values.until.trim() : '';
		const lastInput = typeof ctx.values.last === 'string' ? ctx.values.last.trim() : '';
		const { sinceDate, untilDate } = resolveDateRangeFilters({
			sinceInput,
			untilInput,
			lastInput,
		});

		const [entries, sessionMetadataMap] = await Promise.all([
			loadOpenCodeMessages(),
			loadOpenCodeSessions(),
		]);
		const timeFilteredEntries = filterEntriesByDateRange(entries, sinceDate, untilDate);
		const filteredEntries = filterEntriesBySessionProjectFilters(
			timeFilteredEntries,
			sessionMetadataMap,
			{
				idInput,
				projectInput,
			},
		);

		if (filteredEntries.length === 0) {
			const output = jsonOutput
				? JSON.stringify({ models: [], totals: null })
				: 'No OpenCode usage data found.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		using fetcher = new LiteLLMPricingFetcher({ offline: false, logger });

		const entriesByModel = groupBy(filteredEntries, (entry) => entry.model);

		const modelData: Array<
			ModelTokenData & {
				model: string;
				componentCosts: ComponentCosts;
			}
		> = [];

		for (const [model, modelEntries] of Object.entries(entriesByModel)) {
			let inputTokens = 0;
			let outputTokens = 0;
			let reasoningTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let totalCost = 0;

			for (const entry of modelEntries) {
				const cost = await calculateCostForEntry(entry, fetcher);
				inputTokens += entry.usage.inputTokens;
				outputTokens += entry.usage.outputTokens;
				reasoningTokens += entry.usage.reasoningTokens;
				cacheCreationTokens += entry.usage.cacheCreationInputTokens;
				cacheReadTokens += entry.usage.cacheReadInputTokens;
				totalCost += cost;
			}

			const componentCosts = await calculateComponentCostsFromEntries(modelEntries, model, fetcher);

			modelData.push({
				model,
				inputTokens,
				outputTokens,
				reasoningTokens,
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
			reasoningTokens: modelData.reduce((sum, d) => sum + d.reasoningTokens, 0),
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
							reasoningTokens: d.reasoningTokens,
							cacheReadTokens: d.cacheReadTokens,
							totalCost: d.totalCost,
						})),
						totals: {
							inputTokens: totals.inputTokens + totals.cacheCreationTokens + totals.cacheReadTokens,
							outputTokens: totals.outputTokens,
							reasoningTokens: totals.reasoningTokens,
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
			head: [
				'Model',
				'Input Uncached',
				'Input Cached',
				'Input Total',
				'Output/Reasoning%',
				'Cost (USD)',
			],
			colAligns: ['left', 'right', 'right', 'right', 'right', 'right'],
			compactHead: ['Model', 'Input Total', 'Output/Reasoning%', 'Cost (USD)'],
			compactColAligns: ['left', 'right', 'right', 'right'],
			compactThreshold: 80,
			forceCompact: Boolean(ctx.values.compact),
			style: { head: ['cyan'] },
		});

		for (const data of modelData) {
			table.push([
				pc.bold(data.model),
				formatUncachedInputColumn(data, data.componentCosts),
				formatCachedInputColumn(data, data.componentCosts),
				formatInputColumn(data, data.componentCosts),
				formatOutputColumn(data, data.componentCosts),
				pc.green(formatCurrency(data.totalCost)),
			]);
		}

		addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);

		const totalInput = totalInputTokens(totals);
		table.push([
			pc.yellow('Total'),
			pc.yellow(
				formatAggregateUncachedInputColumn(
					totals.inputTokens,
					totals.cacheCreationTokens,
					totals.cacheReadTokens,
				),
			),
			pc.yellow(
				formatAggregateCachedInputColumn(
					totals.inputTokens,
					totals.cacheCreationTokens,
					totals.cacheReadTokens,
				),
			),
			pc.yellow(formatNumber(totalInput)),
			pc.yellow(formatOutputValueWithReasoningPct(totals.outputTokens, totals.reasoningTokens)),
			pc.yellow(pc.green(formatCurrency(totals.totalCost))),
		]);

		// eslint-disable-next-line no-console
		console.log(table.toString());

		if (table.isCompactMode()) {
			// eslint-disable-next-line no-console
			console.log('\nRunning in Compact Mode');
			// eslint-disable-next-line no-console
			console.log('Expand terminal width to see uncached/cached input columns');
		}
	},
});
