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
				? JSON.stringify({ weekly: [], totals: null })
				: 'No OpenCode usage data found.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		using fetcher = new LiteLLMPricingFetcher({ offline: false, logger });

		const entriesByWeek = groupBy(entries, (entry) => getISOWeek(entry.timestamp));

		const weeklyData: Array<{
			week: string;
			inputTokens: number;
			outputTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			totalCost: number;
			modelsUsed: string[];
			modelBreakdown: Record<string, ModelTokenData>;
		}> = [];

		for (const [week, weekEntries] of Object.entries(entriesByWeek)) {
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let totalCost = 0;
			const modelsSet = new Set<string>();
			const modelBreakdown: Record<string, ModelTokenData> = {};

			for (const entry of weekEntries) {
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

			weeklyData.push({
				week,
				inputTokens,
				outputTokens,
				cacheCreationTokens,
				cacheReadTokens,
				totalCost,
				modelsUsed: Array.from(modelsSet),
				modelBreakdown,
			});
		}

		weeklyData.sort((a, b) => a.week.localeCompare(b.week));

		const totals = {
			inputTokens: weeklyData.reduce((sum, d) => sum + d.inputTokens, 0),
			outputTokens: weeklyData.reduce((sum, d) => sum + d.outputTokens, 0),
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

		const table: ResponsiveTable = new ResponsiveTable({
			head: ['Week', 'Models', 'Input', 'Output', 'Cache', 'Cost (USD)'],
			colAligns: ['left', 'left', 'right', 'right', 'right', 'right'],
			compactHead: ['Week', 'Models', 'Input', 'Output', 'Cost (USD)'],
			compactColAligns: ['left', 'left', 'right', 'right', 'right'],
			compactThreshold: 90,
			forceCompact: Boolean(ctx.values.compact),
			style: { head: ['cyan'] },
			dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
		});

		for (const data of weeklyData) {
			const weekInput = data.inputTokens + data.cacheCreationTokens + data.cacheReadTokens;

			// Summary Row (no $/M rates — mixed models)
			table.push([
				pc.bold(data.week),
				pc.bold('Weekly Total'),
				pc.bold(formatNumber(weekInput)),
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
					pc.dim(formatInputColumn(metrics, componentCosts)),
					pc.dim(formatOutputColumn(metrics, componentCosts)),
					pc.dim(formatCacheColumn(metrics)),
					pc.dim(formatCurrency(metrics.totalCost)),
				]);
			}

			// Add separator after each week
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
