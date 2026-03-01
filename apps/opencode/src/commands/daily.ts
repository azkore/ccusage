import type { ComponentCosts, ModelTokenData } from '../cost-utils.ts';
import type { LoadedUsageEntry } from '../data-loader.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { groupBy } from 'es-toolkit';
import { define } from 'gunshi';
import {
	formatBreakdownLabelForTable,
	formatReportSourceLabel,
	isDisplayedZeroCost,
	resolveBreakdownDimensions,
} from '../breakdown.ts';
import {
	calculateAggregateComponentCostsFromEntries,
	calculateComponentCostsFromEntries,
	calculateCostForEntry,
} from '../cost-utils.ts';
import { loadUsageData, parseUsageSource } from '../data-loader.ts';
import {
	filterEntriesByDateRange,
	formatDateKey,
	resolveDateRangeFilters,
} from '../date-filter.ts';
import {
	createFullModelLabel,
	extractProjectName,
	filterEntriesBySessionProjectFilters,
	parseFilterInputs,
} from '../entry-filter.ts';
import { logger } from '../logger.ts';
import { setModelAliasEnabled } from '../model-alias.ts';
import {
	applyModelAliasForDisplay,
	createModelLabelResolver,
	formatModelLabelForTable,
} from '../model-display.ts';
import {
	buildAggregateSummaryRow,
	buildModelBreakdownRow,
	createUsageTable,
	isCompactTable,
	remapTokensForAggregate,
} from '../usage-table.ts';

export const dailyCommand = define({
	name: 'daily',
	description:
		'Show OpenCode token usage grouped by day. Use --breakdown model,cost for per-model rate details ($/M→$...).',
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
			description: 'Filter by model name (comma-separated)',
		},
		provider: {
			type: 'string',
			description: 'Filter by provider name (comma-separated)',
		},
		'full-model': {
			type: 'string',
			short: 'M',
			description: 'Filter by source/provider/model composite (comma-separated)',
		},
		providers: {
			type: 'boolean',
			short: 'P',
			description: 'Show provider prefixes in model names',
		},
		alias: {
			type: 'boolean',
			description: 'Apply model aliases from ~/.config/causage/aliases.yaml',
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
		utc: {
			type: 'boolean',
			description: 'Use UTC for parsing and grouping dates/times',
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
			description:
				'Enable all breakdown dimensions for this report (shortcut for --breakdown <all supported>)',
		},
		breakdown: {
			type: 'string',
			description:
				"Choose breakdown dimensions (comma-separated): source, provider, model, full-model, cost, percent, project, session. Use 'none' to disable.",
		},
		'skip-zero': {
			type: 'boolean',
			description: 'Hide rows whose cost rounds to $0.00',
		},
	},
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);
		const skipZero = ctx.values['skip-zero'] === true;
		const showProviders = ctx.values.providers === true;
		setModelAliasEnabled(ctx.values.alias === true);
		const idInput = typeof ctx.values.id === 'string' ? ctx.values.id.trim() : '';
		const projectInput = typeof ctx.values.project === 'string' ? ctx.values.project.trim() : '';
		const modelInputs = parseFilterInputs(ctx.values.model);
		const providerInputs = parseFilterInputs(ctx.values.provider);
		const fullModelInputs = parseFilterInputs(ctx.values['full-model']);
		const sourceInput =
			typeof ctx.values.source === 'string' ? ctx.values.source.trim() : undefined;
		const source = parseUsageSource(sourceInput);
		const breakdownInput =
			typeof ctx.values.breakdown === 'string' ? ctx.values.breakdown.trim() : '';
		const availableBreakdowns: Array<
			'source' | 'provider' | 'model' | 'full-model' | 'cost' | 'percent' | 'project' | 'session'
		> = ['source', 'provider', 'model', 'full-model', 'cost', 'percent', 'project', 'session'];
		const breakdowns = resolveBreakdownDimensions({
			full: ctx.values.full === true,
			breakdownInput,
			available: availableBreakdowns,
		});
		const groupingBreakdowns = breakdowns.filter(
			(dimension) => dimension !== 'cost' && dimension !== 'percent',
		);
		const showBreakdown = groupingBreakdowns.length > 0;
		const includeSource = breakdowns.includes('source');
		const includeProvider = breakdowns.includes('provider');
		const includeModel = breakdowns.includes('model');
		const includeFullModel = breakdowns.includes('full-model');
		const includeCost = breakdowns.includes('cost');
		const includePercent = breakdowns.includes('percent');
		const includeProject = breakdowns.includes('project');
		const includeSession = breakdowns.includes('session');
		const splitValueDetailColumns =
			(includePercent || includeCost) && !(includeCost && (includeModel || includeFullModel));
		const splitPercentColumns = includePercent
			? {
					output: showBreakdown,
					cacheCreate: true,
					cacheRead: true,
				}
			: undefined;
		const sinceInput = typeof ctx.values.since === 'string' ? ctx.values.since.trim() : '';
		const untilInput = typeof ctx.values.until === 'string' ? ctx.values.until.trim() : '';
		const lastInput = typeof ctx.values.last === 'string' ? ctx.values.last.trim() : '';
		const useUTC = ctx.values.utc === true;
		const { sinceDate, untilDate } = resolveDateRangeFilters({
			sinceInput,
			untilInput,
			lastInput,
			useUTC,
		});

		const { entries, sessionMetadataMap } = await loadUsageData(source);
		const timeFilteredEntries = filterEntriesByDateRange(entries, sinceDate, untilDate);
		const filteredEntries = filterEntriesBySessionProjectFilters(
			timeFilteredEntries,
			sessionMetadataMap,
			{
				idInput,
				projectInput,
				modelInputs,
				providerInputs,
				fullModelInputs,
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

		const entriesByDate = groupBy(filteredEntries, (entry) =>
			formatDateKey(entry.timestamp, useUTC),
		);

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
		const visibleDailyData = skipZero
			? dailyData.filter((data) => !isDisplayedZeroCost(data.totalCost))
			: dailyData;

		if (visibleDailyData.length === 0) {
			const output = jsonOutput
				? JSON.stringify({ source, daily: [], totals: null })
				: 'No usage rows found after applying --skip-zero.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		const totals = {
			inputTokens: visibleDailyData.reduce((sum, d) => sum + d.inputTokens, 0),
			outputTokens: visibleDailyData.reduce((sum, d) => sum + d.outputTokens, 0),
			reasoningTokens: visibleDailyData.reduce((sum, d) => sum + d.reasoningTokens, 0),
			cacheCreationTokens: visibleDailyData.reduce((sum, d) => sum + d.cacheCreationTokens, 0),
			cacheReadTokens: visibleDailyData.reduce((sum, d) => sum + d.cacheReadTokens, 0),
			totalCost: visibleDailyData.reduce((sum, d) => sum + d.totalCost, 0),
		};
		if (jsonOutput) {
			// eslint-disable-next-line no-console
			console.log(
				JSON.stringify(
					{
						source,
						daily: visibleDailyData,
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
			showPercent: includePercent,
			splitValueDetailColumns,
			splitPercentColumns,
			forceCompact: Boolean(ctx.values.compact),
		});
		const compact = isCompactTable(table);
		const visibleEntriesForTotals = visibleDailyData.flatMap(
			(data) => entriesByDate[data.date] ?? [],
		);
		const totalsColumnCosts = includeCost
			? await calculateAggregateComponentCostsFromEntries(visibleEntriesForTotals, fetcher)
			: undefined;

		for (const data of visibleDailyData) {
			const dayEntries = entriesByDate[data.date] ?? [];
			const summaryColumnCosts = includeCost
				? await calculateAggregateComponentCostsFromEntries(dayEntries, fetcher)
				: undefined;

			// Summary Row (no $/M rates — mixed models)
			table.push(
				buildAggregateSummaryRow(data.date, 'Daily Total', data, {
					bold: true,
					compact,
					showPercent: includePercent,
					hideZeroDetail: skipZero,
					splitValueDetailColumns,
					splitPercentColumns,
					columnCosts: summaryColumnCosts,
				}),
			);

			if (!compact && showBreakdown) {
				const groupedEntries = groupBy(dayEntries, (entry) => {
					const keyParts: string[] = [];
					const metadata = sessionMetadataMap.get(entry.sessionID);
					const projectName = extractProjectName(
						metadata?.directory ?? 'unknown',
						metadata?.projectID ?? '',
					);
					const modelKey = includeProvider
						? plainModelLabelForEntry(entry)
						: modelLabelForEntry(entry);
					if (includeFullModel) {
						keyParts.push(createFullModelLabel(entry));
					} else {
						if (includeSource) {
							keyParts.push(entry.source);
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
					}
					if (includeProject) {
						keyParts.push(projectName);
					}
					if (includeSession) {
						keyParts.push(entry.sessionID);
					}

					return keyParts.join('\u001F');
				});

				const breakdownRows = Object.entries(groupedEntries)
					.map(([groupKey, groupRows]) => ({
						label: groupKey.split('\u001F').join('/'),
						entries: groupRows,
						aggregate: aggregateEntries(groupRows),
					}))
					.filter((row) => !skipZero || !isDisplayedZeroCost(row.aggregate.totals.totalCost))
					.sort((a, b) => b.aggregate.totals.totalCost - a.aggregate.totals.totalCost);

				for (const row of breakdownRows) {
					const modelMetricsValues = Object.values(row.aggregate.modelBreakdown);
					if (
						includeCost &&
						(includeModel || includeFullModel) &&
						modelMetricsValues.length === 1
					) {
						const modelMetrics = modelMetricsValues[0];
						if (modelMetrics != null) {
							const pricingModel = row.entries[0]?.model ?? row.label;
							const rowLabel =
								groupingBreakdowns.length === 1 && includeModel
									? formatModelLabelForTable(row.label)
									: formatBreakdownLabelForTable(row.label);
							const componentCosts: ComponentCosts = await calculateComponentCostsFromEntries(
								row.entries,
								pricingModel,
								fetcher,
							);

							table.push(
								buildModelBreakdownRow('', rowLabel, modelMetrics, componentCosts, {
									showPercent: includePercent,
									hideZeroDetail: skipZero,
								}),
							);
							continue;
						}
					}

					table.push(
						buildAggregateSummaryRow(
							'',
							applyModelAliasForDisplay(row.label),
							row.aggregate.totals,
							includeCost
								? {
										compact,
										showPercent: includePercent,
										hideZeroDetail: skipZero,
										splitValueDetailColumns,
										splitPercentColumns,
										columnCosts: await calculateAggregateComponentCostsFromEntries(
											row.entries,
											fetcher,
										),
									}
								: {
										compact,
										showPercent: includePercent,
										hideZeroDetail: skipZero,
										splitValueDetailColumns,
										splitPercentColumns,
									},
						),
					);
				}
			}
		}

		table.push(
			buildAggregateSummaryRow('Total', '', totals, {
				yellow: true,
				compact,
				showPercent: includePercent,
				hideZeroDetail: skipZero,
				splitValueDetailColumns,
				splitPercentColumns,
				columnCosts: totalsColumnCosts,
			}),
		);

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
