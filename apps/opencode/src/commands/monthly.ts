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
import { calculateCostForEntry } from '../cost-utils.ts';
import { loadOpenCodeMessages } from '../data-loader.ts';
import { logger } from '../logger.ts';

const TABLE_COLUMN_COUNT = 8;

export const monthlyCommand = define({
	name: 'monthly',
	description: 'Show OpenCode token usage grouped by month',
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
				? JSON.stringify({ monthly: [], totals: null })
				: 'No OpenCode usage data found.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		using fetcher = new LiteLLMPricingFetcher({ offline: false, logger });

		const entriesByMonth = groupBy(entries, (entry) => entry.timestamp.toISOString().slice(0, 7));

		const monthlyData: Array<{
			month: string;
			inputTokens: number;
			outputTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			totalTokens: number;
			totalCost: number;
			modelsUsed: string[];
			modelBreakdown: Record<
				string,
				{
					inputTokens: number;
					outputTokens: number;
					cacheCreationTokens: number;
					cacheReadTokens: number;
					totalCost: number;
				}
			>;
		}> = [];

		for (const [month, monthEntries] of Object.entries(entriesByMonth)) {
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let totalCost = 0;
			const modelsSet = new Set<string>();
			const modelBreakdown: Record<
				string,
				{
					inputTokens: number;
					outputTokens: number;
					cacheCreationTokens: number;
					cacheReadTokens: number;
					totalCost: number;
				}
			> = {};

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

			const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;

			monthlyData.push({
				month,
				inputTokens,
				outputTokens,
				cacheCreationTokens,
				cacheReadTokens,
				totalTokens,
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
			totalTokens: monthlyData.reduce((sum, d) => sum + d.totalTokens, 0),
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
			head: [
				'Month',
				'Models',
				'Input',
				'Output',
				'Cache Create',
				'Cache Read',
				'Total Tokens',
				'Cost (USD)',
			],
			colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
			compactHead: ['Month', 'Models', 'Input', 'Output', 'Cost (USD)'],
			compactColAligns: ['left', 'left', 'right', 'right', 'right'],
			compactThreshold: 100,
			forceCompact: Boolean(ctx.values.compact),
			style: { head: ['cyan'] },
			dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
		});

		for (const data of monthlyData) {
			// Summary Row
			table.push([
				pc.bold(data.month),
				pc.bold('Monthly Total'),
				pc.bold(formatNumber(data.inputTokens)),
				pc.bold(formatNumber(data.outputTokens)),
				pc.bold(formatNumber(data.cacheCreationTokens)),
				pc.bold(formatNumber(data.cacheReadTokens)),
				pc.bold(formatNumber(data.totalTokens)),
				pc.bold(formatCurrency(data.totalCost)),
			]);

			// Breakdown Rows
			const sortedModels = Object.entries(data.modelBreakdown).sort(
				(a, b) => b[1].totalCost - a[1].totalCost,
			);

			for (const [model, metrics] of sortedModels) {
				const totalModelTokens =
					metrics.inputTokens +
					metrics.outputTokens +
					metrics.cacheCreationTokens +
					metrics.cacheReadTokens;

				table.push([
					'',
					pc.dim(`- ${model}`),
					pc.dim(formatNumber(metrics.inputTokens)),
					pc.dim(formatNumber(metrics.outputTokens)),
					pc.dim(formatNumber(metrics.cacheCreationTokens)),
					pc.dim(formatNumber(metrics.cacheReadTokens)),
					pc.dim(formatNumber(totalModelTokens)),
					pc.dim(formatCurrency(metrics.totalCost)),
				]);
			}

			// Add separator after each month
			addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);
		}

		table.push([
			pc.yellow('Total'),
			'',
			pc.yellow(formatNumber(totals.inputTokens)),
			pc.yellow(formatNumber(totals.outputTokens)),
			pc.yellow(formatNumber(totals.cacheCreationTokens)),
			pc.yellow(formatNumber(totals.cacheReadTokens)),
			pc.yellow(formatNumber(totals.totalTokens)),
			pc.yellow(formatCurrency(totals.totalCost)),
		]);

		// eslint-disable-next-line no-console
		console.log(table.toString());

		if (table.isCompactMode()) {
			// eslint-disable-next-line no-console
			console.log('\nRunning in Compact Mode');
			// eslint-disable-next-line no-console
			console.log('Expand terminal width to see cache metrics and total tokens');
		}
	},
});
