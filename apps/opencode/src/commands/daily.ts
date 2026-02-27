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
	formatLocalDateKey,
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
			description: 'Comma-separated breakdowns (source,provider,model) or none',
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
		const availableBreakdowns: Array<'source' | 'provider' | 'model'> =
			source === 'all' ? ['source', 'provider', 'model'] : ['provider', 'model'];
		const breakdowns = resolveBreakdownDimensions({
			full: ctx.values.full === true,
			breakdownInput,
			available: availableBreakdowns,
		});
		const showBreakdown = breakdowns.length > 0;
		const includeSource = breakdowns.includes('source');
		const includeProvider = breakdowns.includes('provider');
		const includeModel = breakdowns.includes('model');
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
				? JSON.stringify({ source, daily: [], totals: null })
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
		const plainModelLabelForEntry = createModelLabelResolver(filteredEntries, 'never');

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
		if (jsonOutput) {
			// eslint-disable-next-line no-console
			console.log(
				JSON.stringify(
					{
						source,
						daily: dailyData,
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
		console.log(`\n📊 ${sourceLabel} Token Usage Report - Daily\n`);

		const table = createUsageTable({
			firstColumnName: 'Date',
			hasModelsColumn: true,
			forceCompact: Boolean(ctx.values.compact),
		});
		const compact = isCompactTable(table);

		for (const data of dailyData) {
			// Summary Row (no $/M rates — mixed models)
			table.push(buildAggregateSummaryRow(data.date, 'Daily Total', data, { bold: true, compact }));

			if (!compact && showBreakdown) {
				const dayEntries = entriesByDate[data.date] ?? [];
				const groupedEntries = groupBy(dayEntries, (entry) => {
					const keyParts: string[] = [];
					const modelKey = includeProvider
						? plainModelLabelForEntry(entry)
						: modelLabelForEntry(entry);
					if (includeSource) {
						keyParts.push(formatSourceLabel(entry.source));
					}
					if (includeProvider && includeModel) {
						keyParts.push(`${entry.provider}/${modelKey}`);
					} else {
						if (includeProvider) {
							keyParts.push(entry.provider);
						}
						if (includeModel) {
							keyParts.push(modelKey);
						}
					}

					return keyParts.join('\u001F');
				});

				const breakdownRows = Object.entries(groupedEntries)
					.map(([groupKey, groupRows]) => ({
						label: groupKey.split('\u001F').join(' > '),
						entries: groupRows,
						aggregate: aggregateEntries(groupRows),
					}))
					.sort((a, b) => b.aggregate.totals.totalCost - a.aggregate.totals.totalCost);

				for (const row of breakdownRows) {
					const modelMetricsValues = Object.values(row.aggregate.modelBreakdown);
					if (includeModel && modelMetricsValues.length === 1) {
						const modelMetrics = modelMetricsValues[0];
						if (modelMetrics != null) {
							const pricingModel = row.entries[0]?.model ?? row.label;
							const rowLabel = includeSource ? row.label : formatModelLabelForTable(row.label);
							const componentCosts: ComponentCosts = await calculateComponentCostsFromEntries(
								row.entries,
								pricingModel,
								fetcher,
							);

							table.push(buildModelBreakdownRow('', rowLabel, modelMetrics, componentCosts));
							continue;
						}
					}

					table.push(buildAggregateSummaryRow('', row.label, row.aggregate.totals, { compact }));
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
