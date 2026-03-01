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
import { filterEntriesByDateRange, resolveDateRangeFilters } from '../date-filter.ts';
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

/**
 * Get ISO week number for a date
 * ISO week starts on Monday, first week contains Jan 4th
 * @param date - Date to get ISO week for
 * @returns Week string in format YYYY-Www (e.g., "2025-W51")
 */
function getISOWeek(date: Date, useUTC = false): string {
	if (useUTC) {
		const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
		const dayNum = d.getUTCDay() || 7;
		d.setUTCDate(d.getUTCDate() + 4 - dayNum);
		const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
		const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
		return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
	}

	// Copy date to avoid mutating original
	const d = new Date(date.getTime());

	// Set to nearest Thursday: current date + 4 - current day number
	// Make Sunday's day number 7
	const dayNum = d.getDay() || 7;
	d.setDate(d.getDate() + 4 - dayNum);

	// Get first day of year
	const yearStart = new Date(d.getFullYear(), 0, 1);

	// Calculate full weeks to nearest Thursday
	const weekNo = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);

	// Return formatted string
	return `${d.getFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

export const weeklyCommand = define({
	name: 'weekly',
	description:
		'Show OpenCode token usage grouped by week (ISO week format). Use --breakdown model,cost for per-model rate details ($/M→$...).',
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
				? JSON.stringify({ source, weekly: [], totals: null })
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

		const entriesByWeek = groupBy(filteredEntries, (entry) => getISOWeek(entry.timestamp, useUTC));

		const weeklyData: Array<{
			week: string;
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

		for (const [week, weekEntries] of Object.entries(entriesByWeek)) {
			let inputTokens = 0;
			let outputTokens = 0;
			let reasoningTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let totalCost = 0;
			const modelsSet = new Set<string>();
			const modelBreakdown: Record<string, ModelTokenData> = {};

			for (const entry of weekEntries) {
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

			weeklyData.push({
				week,
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

		weeklyData.sort((a, b) => a.week.localeCompare(b.week));
		const visibleWeeklyData = skipZero
			? weeklyData.filter((data) => !isDisplayedZeroCost(data.totalCost))
			: weeklyData;

		if (visibleWeeklyData.length === 0) {
			const output = jsonOutput
				? JSON.stringify({ source, weekly: [], totals: null })
				: 'No usage rows found after applying --skip-zero.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		const totals = {
			inputTokens: visibleWeeklyData.reduce((sum, d) => sum + d.inputTokens, 0),
			outputTokens: visibleWeeklyData.reduce((sum, d) => sum + d.outputTokens, 0),
			reasoningTokens: visibleWeeklyData.reduce((sum, d) => sum + d.reasoningTokens, 0),
			cacheCreationTokens: visibleWeeklyData.reduce((sum, d) => sum + d.cacheCreationTokens, 0),
			cacheReadTokens: visibleWeeklyData.reduce((sum, d) => sum + d.cacheReadTokens, 0),
			totalCost: visibleWeeklyData.reduce((sum, d) => sum + d.totalCost, 0),
		};
		if (jsonOutput) {
			// eslint-disable-next-line no-console
			console.log(
				JSON.stringify(
					{
						source,
						weekly: visibleWeeklyData,
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
		console.log(`\n📊 ${sourceLabel} Token Usage Report - Weekly\n`);

		const table = createUsageTable({
			firstColumnName: 'Week',
			hasModelsColumn: true,
			showPercent: includePercent,
			splitValueDetailColumns,
			splitPercentColumns,
			forceCompact: Boolean(ctx.values.compact),
		});
		const compact = isCompactTable(table);
		const visibleEntriesForTotals = visibleWeeklyData.flatMap(
			(data) => entriesByWeek[data.week] ?? [],
		);
		const totalsColumnCosts = includeCost
			? await calculateAggregateComponentCostsFromEntries(visibleEntriesForTotals, fetcher)
			: undefined;

		for (const data of visibleWeeklyData) {
			const weekEntries = entriesByWeek[data.week] ?? [];
			const summaryColumnCosts = includeCost
				? await calculateAggregateComponentCostsFromEntries(weekEntries, fetcher)
				: undefined;

			table.push(
				buildAggregateSummaryRow(data.week, 'Weekly Total', data, {
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
				const groupedEntries = groupBy(weekEntries, (entry) => {
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

if (import.meta.vitest != null) {
	const { describe, it, expect } = import.meta.vitest;

	describe('getISOWeek', () => {
		it('should get ISO week for a date in the middle of the year', () => {
			const date = new Date('2025-06-15T10:00:00Z');
			const week = getISOWeek(date);
			expect(week).toBe('2025-W24');
		});

		it('should handle year boundary correctly', () => {
			// Dec 29, 2025 is a Monday (first week of 2026 in ISO)
			const date = new Date('2025-12-29T10:00:00Z');
			const week = getISOWeek(date);
			expect(week).toBe('2026-W01');
		});

		it('should handle first week of year', () => {
			// Jan 5, 2025 is a Sunday (week 1 of 2025)
			const date = new Date('2025-01-05T10:00:00Z');
			const week = getISOWeek(date);
			expect(week).toBe('2025-W01');
		});

		it('should handle last days of previous year belonging to week 1', () => {
			// Jan 1, 2025 is a Wednesday (week 1 of 2025)
			const date = new Date('2025-01-01T10:00:00Z');
			const week = getISOWeek(date);
			expect(week).toBe('2025-W01');
		});

		it('supports UTC week calculation when enabled', () => {
			const date = new Date('2025-12-29T10:00:00Z');
			const week = getISOWeek(date, true);
			expect(week).toBe('2026-W01');
		});
	});
}
