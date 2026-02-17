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
import { loadOpenCodeMessages, loadOpenCodeSessions } from '../data-loader.ts';
import {
	filterEntriesByDateRange,
	formatLocalDateKey,
	resolveDateRangeFilters,
} from '../date-filter.ts';
import { filterEntriesBySessionProjectFilters } from '../entry-filter.ts';
import { logger } from '../logger.ts';

const TABLE_COLUMN_COUNT = 6;

export const dailyCommand = define({
	name: 'daily',
	description: 'Show OpenCode token usage grouped by day',
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
		full: {
			type: 'boolean',
			description: 'Show per-model breakdown rows',
		},
	},
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);
		const showBreakdown = ctx.values.full === true;
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
				? JSON.stringify({ daily: [], totals: null })
				: 'No OpenCode usage data found.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		using fetcher = new LiteLLMPricingFetcher({ offline: false, logger });

		const entriesByDate = groupBy(filteredEntries, (entry) => formatLocalDateKey(entry.timestamp));

		const dailyData: Array<{
			date: string;
			inputTokens: number;
			outputTokens: number;
			reasoningTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			totalCost: number;
			modelsUsed: string[];
			modelBreakdown: Record<string, ModelTokenData>;
		}> = [];

		for (const [date, dayEntries] of Object.entries(entriesByDate)) {
			let inputTokens = 0;
			let outputTokens = 0;
			let reasoningTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let totalCost = 0;
			const modelsSet = new Set<string>();
			const modelBreakdown: Record<string, ModelTokenData> = {};

			for (const entry of dayEntries) {
				const cost = await calculateCostForEntry(entry, fetcher);
				inputTokens += entry.usage.inputTokens;
				outputTokens += entry.usage.outputTokens;
				reasoningTokens += entry.usage.reasoningTokens;
				cacheCreationTokens += entry.usage.cacheCreationInputTokens;
				cacheReadTokens += entry.usage.cacheReadInputTokens;
				totalCost += cost;
				modelsSet.add(entry.model);

				let mb = modelBreakdown[entry.model];
				if (mb == null) {
					mb = {
						inputTokens: 0,
						outputTokens: 0,
						reasoningTokens: 0,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						totalCost: 0,
					};
					modelBreakdown[entry.model] = mb;
				}
				mb.inputTokens += entry.usage.inputTokens;
				mb.outputTokens += entry.usage.outputTokens;
				mb.reasoningTokens += entry.usage.reasoningTokens;
				mb.cacheCreationTokens += entry.usage.cacheCreationInputTokens;
				mb.cacheReadTokens += entry.usage.cacheReadInputTokens;
				mb.totalCost += cost;
			}

			dailyData.push({
				date,
				inputTokens,
				outputTokens,
				reasoningTokens,
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
			reasoningTokens: dailyData.reduce((sum, d) => sum + d.reasoningTokens, 0),
			cacheCreationTokens: dailyData.reduce((sum, d) => sum + d.cacheCreationTokens, 0),
			cacheReadTokens: dailyData.reduce((sum, d) => sum + d.cacheReadTokens, 0),
			totalCost: dailyData.reduce((sum, d) => sum + d.totalCost, 0),
		};
		const hasReasoningTokens = totals.reasoningTokens > 0;

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
			head: [
				'Date',
				'Models',
				'Input',
				hasReasoningTokens ? 'Output/Reasoning' : 'Output',
				'Cache',
				'Cost (USD)',
			],
			colAligns: ['left', 'left', 'right', 'right', 'right', 'right'],
			compactHead: [
				'Date',
				'Models',
				'Input',
				hasReasoningTokens ? 'Output/Reasoning' : 'Output',
				'Cost (USD)',
			],
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
				pc.bold(
					hasReasoningTokens
						? `${formatNumber(data.outputTokens)} / ${formatNumber(data.reasoningTokens)}`
						: formatNumber(data.outputTokens),
				),
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
			pc.yellow(
				hasReasoningTokens
					? `${formatNumber(totals.outputTokens)} / ${formatNumber(totals.reasoningTokens)}`
					: formatNumber(totals.outputTokens),
			),
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
