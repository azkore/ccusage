import type { ComponentCosts, ModelTokenData } from '../cost-utils.ts';
import type { LoadedUsageEntry } from '../data-loader.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { groupBy } from 'es-toolkit';
import { define } from 'gunshi';
import {
	formatReportSourceLabel,
	formatSourceLabel,
	resolveBreakdownDimensions,
} from '../breakdown.ts';
import { calculateComponentCostsFromEntries, calculateCostForEntry } from '../cost-utils.ts';
import { loadUsageData, parseUsageSource } from '../data-loader.ts';
import {
	filterEntriesByDateRange,
	formatLocalMonthKey,
	resolveDateRangeFilters,
} from '../date-filter.ts';
import { filterEntriesBySessionProjectFilters } from '../entry-filter.ts';
import { logger } from '../logger.ts';
import { createModelLabelResolver, formatModelLabelForTable } from '../model-display.ts';
import {
	buildAggregateSummaryRow,
	buildModelBreakdownRow,
	createUsageTable,
	isCompactTable,
	remapTokensForAggregate,
} from '../usage-table.ts';

export const monthlyCommand = define({
	name: 'monthly',
	description: 'Show OpenCode token usage grouped by month',
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
		model: {
			type: 'string',
			short: 'm',
			description: 'Filter models by name/provider',
		},
		providers: {
			type: 'boolean',
			short: 'P',
			description: 'Show provider prefixes in model names',
		},
		source: {
			type: 'string',
			short: 's',
			description: 'Data source: opencode, claude, or all (default: all)',
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
			description: 'Show all available breakdown rows',
		},
		breakdown: {
			type: 'string',
			description: 'Comma-separated breakdowns (source,model) or none',
		},
	},
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);
		const showProviders = ctx.values.providers === true;
		const idInput = typeof ctx.values.id === 'string' ? ctx.values.id.trim() : '';
		const projectInput = typeof ctx.values.project === 'string' ? ctx.values.project.trim() : '';
		const modelInput = typeof ctx.values.model === 'string' ? ctx.values.model.trim() : '';
		const sourceInput =
			typeof ctx.values.source === 'string' ? ctx.values.source.trim() : undefined;
		const source = parseUsageSource(sourceInput);
		const breakdownInput =
			typeof ctx.values.breakdown === 'string' ? ctx.values.breakdown.trim() : '';
		const availableBreakdowns: Array<'source' | 'model'> =
			source === 'all' ? ['source', 'model'] : ['model'];
		const breakdowns = resolveBreakdownDimensions({
			full: ctx.values.full === true,
			breakdownInput,
			available: availableBreakdowns,
		});
		const showSourceBreakdown = breakdowns.includes('source');
		const showModelBreakdown = breakdowns.includes('model');
		const sinceInput = typeof ctx.values.since === 'string' ? ctx.values.since.trim() : '';
		const untilInput = typeof ctx.values.until === 'string' ? ctx.values.until.trim() : '';
		const lastInput = typeof ctx.values.last === 'string' ? ctx.values.last.trim() : '';
		const { sinceDate, untilDate } = resolveDateRangeFilters({
			sinceInput,
			untilInput,
			lastInput,
		});

		const { entries, sessionMetadataMap } = await loadUsageData(source);
		const timeFilteredEntries = filterEntriesByDateRange(entries, sinceDate, untilDate);
		const filteredEntries = filterEntriesBySessionProjectFilters(
			timeFilteredEntries,
			sessionMetadataMap,
			{
				idInput,
				projectInput,
				modelInput,
			},
		);

		if (filteredEntries.length === 0) {
			const output = jsonOutput
				? JSON.stringify({ source, monthly: [], totals: null })
				: 'No usage data found.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		using fetcher = new LiteLLMPricingFetcher({ offline: false, logger });
		const modelLabelForEntry = createModelLabelResolver(
			filteredEntries,
			showProviders ? 'always' : 'never',
		);

		const entriesByMonth = groupBy(filteredEntries, (entry) =>
			formatLocalMonthKey(entry.timestamp),
		);

		const monthlyData: Array<{
			month: string;
			inputTokens: number;
			outputTokens: number;
			reasoningTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			totalCost: number;
			modelsUsed: string[];
			modelBreakdown: Record<string, ModelTokenData>;
		}> = [];
		const breakdownEntriesByMonth: Record<string, Record<string, LoadedUsageEntry[]>> = {};
		const entryCostMap = new Map<LoadedUsageEntry, number>();

		const aggregateEntries = (groupEntries: LoadedUsageEntry[]) => {
			let inputTokens = 0;
			let outputTokens = 0;
			let reasoningTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let totalCost = 0;
			const modelBreakdown: Record<string, ModelTokenData> = {};
			const modelEntriesByModel: Record<string, LoadedUsageEntry[]> = {};

			for (const entry of groupEntries) {
				const modelLabel = modelLabelForEntry(entry);
				const cost = entryCostMap.get(entry) ?? 0;
				const mapped = remapTokensForAggregate(entry.usage);
				inputTokens += mapped.base;
				outputTokens += entry.usage.outputTokens;
				reasoningTokens += entry.usage.reasoningTokens;
				cacheCreationTokens += mapped.cacheCreate;
				cacheReadTokens += mapped.cacheRead;
				totalCost += cost;

				let mb = modelBreakdown[modelLabel];
				if (mb == null) {
					mb = {
						inputTokens: 0,
						outputTokens: 0,
						reasoningTokens: 0,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						totalCost: 0,
					};
					modelBreakdown[modelLabel] = mb;
				}

				mb.inputTokens += entry.usage.inputTokens;
				mb.outputTokens += entry.usage.outputTokens;
				mb.reasoningTokens += entry.usage.reasoningTokens;
				mb.cacheCreationTokens += entry.usage.cacheCreationInputTokens;
				mb.cacheReadTokens += entry.usage.cacheReadInputTokens;
				mb.totalCost += cost;

				let modelEntries = modelEntriesByModel[modelLabel];
				if (modelEntries == null) {
					modelEntries = [];
					modelEntriesByModel[modelLabel] = modelEntries;
				}
				modelEntries.push(entry);
			}

			return {
				totals: {
					inputTokens,
					outputTokens,
					reasoningTokens,
					cacheCreationTokens,
					cacheReadTokens,
					totalCost,
				},
				modelBreakdown,
				modelEntriesByModel,
			};
		};

		for (const [month, monthEntries] of Object.entries(entriesByMonth)) {
			let inputTokens = 0;
			let outputTokens = 0;
			let reasoningTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let totalCost = 0;
			const modelsSet = new Set<string>();
			const modelBreakdown: Record<string, ModelTokenData> = {};
			const modelEntriesByModel: Record<string, LoadedUsageEntry[]> = {};

			for (const entry of monthEntries) {
				const modelLabel = modelLabelForEntry(entry);
				const cost = await calculateCostForEntry(entry, fetcher);
				entryCostMap.set(entry, cost);
				const mapped = remapTokensForAggregate(entry.usage);
				inputTokens += mapped.base;
				outputTokens += entry.usage.outputTokens;
				reasoningTokens += entry.usage.reasoningTokens;
				cacheCreationTokens += mapped.cacheCreate;
				cacheReadTokens += mapped.cacheRead;
				totalCost += cost;
				modelsSet.add(modelLabel);

				let mb = modelBreakdown[modelLabel];
				if (mb == null) {
					mb = {
						inputTokens: 0,
						outputTokens: 0,
						reasoningTokens: 0,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						totalCost: 0,
					};
					modelBreakdown[modelLabel] = mb;
				}
				mb.inputTokens += entry.usage.inputTokens;
				mb.outputTokens += entry.usage.outputTokens;
				mb.reasoningTokens += entry.usage.reasoningTokens;
				mb.cacheCreationTokens += entry.usage.cacheCreationInputTokens;
				mb.cacheReadTokens += entry.usage.cacheReadInputTokens;
				mb.totalCost += cost;

				let modelEntries = modelEntriesByModel[modelLabel];
				if (modelEntries == null) {
					modelEntries = [];
					modelEntriesByModel[modelLabel] = modelEntries;
				}
				modelEntries.push(entry);
			}

			monthlyData.push({
				month,
				inputTokens,
				outputTokens,
				reasoningTokens,
				cacheCreationTokens,
				cacheReadTokens,
				totalCost,
				modelsUsed: Array.from(modelsSet),
				modelBreakdown,
			});
			breakdownEntriesByMonth[month] = modelEntriesByModel;
		}

		monthlyData.sort((a, b) => a.month.localeCompare(b.month));

		const totals = {
			inputTokens: monthlyData.reduce((sum, d) => sum + d.inputTokens, 0),
			outputTokens: monthlyData.reduce((sum, d) => sum + d.outputTokens, 0),
			reasoningTokens: monthlyData.reduce((sum, d) => sum + d.reasoningTokens, 0),
			cacheCreationTokens: monthlyData.reduce((sum, d) => sum + d.cacheCreationTokens, 0),
			cacheReadTokens: monthlyData.reduce((sum, d) => sum + d.cacheReadTokens, 0),
			totalCost: monthlyData.reduce((sum, d) => sum + d.totalCost, 0),
		};
		if (jsonOutput) {
			// eslint-disable-next-line no-console
			console.log(
				JSON.stringify(
					{
						source,
						monthly: monthlyData,
						totals,
					},
					null,
					2,
				),
			);
			return;
		}

		const sourceLabel = formatReportSourceLabel(source);

		// eslint-disable-next-line no-console
		console.log(`\n📊 ${sourceLabel} Token Usage Report - Monthly\n`);

		const table = createUsageTable({
			firstColumnName: 'Month',
			hasModelsColumn: true,
			forceCompact: Boolean(ctx.values.compact),
		});
		const compact = isCompactTable(table);

		const pushModelBreakdownRows = async (
			modelBreakdown: Record<string, ModelTokenData>,
			entriesByModel: Record<string, LoadedUsageEntry[]>,
		) => {
			const sortedModels = Object.entries(modelBreakdown).sort(
				(a, b) => b[1].totalCost - a[1].totalCost,
			);

			for (const [model, metrics] of sortedModels) {
				const modelEntries = entriesByModel[model] ?? [];
				const pricingModel = modelEntries[0]?.model ?? model;
				const componentCosts: ComponentCosts = await calculateComponentCostsFromEntries(
					modelEntries,
					pricingModel,
					fetcher,
				);

				table.push(
					buildModelBreakdownRow('', formatModelLabelForTable(model), metrics, componentCosts),
				);
			}
		};

		for (const data of monthlyData) {
			table.push(
				buildAggregateSummaryRow(data.month, 'Monthly Total', data, { bold: true, compact }),
			);

			if (!compact && (showSourceBreakdown || showModelBreakdown)) {
				const monthEntries = entriesByMonth[data.month] ?? [];

				if (showSourceBreakdown) {
					const entriesBySource = groupBy(monthEntries, (entry) => entry.source);
					const sourceRows = Object.entries(entriesBySource)
						.map(([entrySource, sourceEntries]) => ({
							entrySource: entrySource as 'opencode' | 'claude',
							aggregate: aggregateEntries(sourceEntries),
						}))
						.sort((a, b) => b.aggregate.totals.totalCost - a.aggregate.totals.totalCost);

					for (const sourceRow of sourceRows) {
						table.push(
							buildAggregateSummaryRow(
								'',
								`${formatSourceLabel(sourceRow.entrySource)} Total`,
								sourceRow.aggregate.totals,
								{ compact },
							),
						);

						if (showModelBreakdown) {
							await pushModelBreakdownRows(
								sourceRow.aggregate.modelBreakdown,
								sourceRow.aggregate.modelEntriesByModel,
							);
						}
					}
				} else if (showModelBreakdown) {
					await pushModelBreakdownRows(
						data.modelBreakdown,
						breakdownEntriesByMonth[data.month] ?? {},
					);
				}
			}
		}

		table.push(buildAggregateSummaryRow('Total', '', totals, { yellow: true, compact }));

		// eslint-disable-next-line no-console
		console.log(table.toString());

		if (compact) {
			// eslint-disable-next-line no-console
			console.log('\nRunning in Compact Mode');
			// eslint-disable-next-line no-console
			console.log('Expand terminal width to see cache columns');
		}
	},
});
