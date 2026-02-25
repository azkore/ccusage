import type { ComponentCosts, ModelTokenData } from '../cost-utils.ts';
import type { LoadedUsageEntry } from '../data-loader.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { groupBy } from 'es-toolkit';
import { define } from 'gunshi';
import { calculateComponentCostsFromEntries, calculateCostForEntry } from '../cost-utils.ts';
import { loadOpenCodeMessages, loadOpenCodeSessions } from '../data-loader.ts';
import { filterEntriesByDateRange, resolveDateRangeFilters } from '../date-filter.ts';
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

/**
 * Get ISO week number for a date
 * ISO week starts on Monday, first week contains Jan 4th
 * @param date - Date to get ISO week for
 * @returns Week string in format YYYY-Www (e.g., "2025-W51")
 */
function getISOWeek(date: Date): string {
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
	description: 'Show OpenCode token usage grouped by week (ISO week format)',
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
		const showProviders = ctx.values.providers === true;
		const idInput = typeof ctx.values.id === 'string' ? ctx.values.id.trim() : '';
		const projectInput = typeof ctx.values.project === 'string' ? ctx.values.project.trim() : '';
		const modelInput = typeof ctx.values.model === 'string' ? ctx.values.model.trim() : '';
		const sinceInput = typeof ctx.values.since === 'string' ? ctx.values.since.trim() : '';
		const untilInput = typeof ctx.values.until === 'string' ? ctx.values.until.trim() : '';
		const showBreakdown = ctx.values.full === true;
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
				modelInput,
			},
		);

		if (filteredEntries.length === 0) {
			const output = jsonOutput
				? JSON.stringify({ weekly: [], totals: null })
				: 'No OpenCode usage data found.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		using fetcher = new LiteLLMPricingFetcher({ offline: false, logger });
		const modelLabelForEntry = createModelLabelResolver(
			filteredEntries,
			showProviders ? 'always' : 'never',
		);

		const entriesByWeek = groupBy(filteredEntries, (entry) => getISOWeek(entry.timestamp));

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
		const breakdownEntriesByWeek: Record<string, Record<string, LoadedUsageEntry[]>> = {};

		for (const [week, weekEntries] of Object.entries(entriesByWeek)) {
			let inputTokens = 0;
			let outputTokens = 0;
			let reasoningTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let totalCost = 0;
			const modelsSet = new Set<string>();
			const modelBreakdown: Record<string, ModelTokenData> = {};
			const modelEntriesByModel: Record<string, LoadedUsageEntry[]> = {};

			for (const entry of weekEntries) {
				const modelLabel = modelLabelForEntry(entry);
				const cost = await calculateCostForEntry(entry, fetcher);
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
			breakdownEntriesByWeek[week] = modelEntriesByModel;
		}

		weeklyData.sort((a, b) => a.week.localeCompare(b.week));

		const totals = {
			inputTokens: weeklyData.reduce((sum, d) => sum + d.inputTokens, 0),
			outputTokens: weeklyData.reduce((sum, d) => sum + d.outputTokens, 0),
			reasoningTokens: weeklyData.reduce((sum, d) => sum + d.reasoningTokens, 0),
			cacheCreationTokens: weeklyData.reduce((sum, d) => sum + d.cacheCreationTokens, 0),
			cacheReadTokens: weeklyData.reduce((sum, d) => sum + d.cacheReadTokens, 0),
			totalCost: weeklyData.reduce((sum, d) => sum + d.totalCost, 0),
		};
		if (jsonOutput) {
			// eslint-disable-next-line no-console
			console.log(
				JSON.stringify(
					{
						weekly: weeklyData,
						totals,
					},
					null,
					2,
				),
			);
			return;
		}

		// eslint-disable-next-line no-console
		console.log('\n📊 OpenCode Token Usage Report - Weekly\n');

		const table = createUsageTable({
			firstColumnName: 'Week',
			hasModelsColumn: true,
			forceCompact: Boolean(ctx.values.compact),
		});
		const compact = isCompactTable(table);

		for (const data of weeklyData) {
			table.push(
				buildAggregateSummaryRow(data.week, 'Weekly Total', data, { bold: true, compact }),
			);

			if (showBreakdown && !compact) {
				const sortedModels = Object.entries(data.modelBreakdown).sort(
					(a, b) => b[1].totalCost - a[1].totalCost,
				);

				for (const [model, metrics] of sortedModels) {
					const modelEntries = breakdownEntriesByWeek[data.week]?.[model] ?? [];
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
	});
}
