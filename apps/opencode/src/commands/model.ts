import type { ComponentCosts, ModelTokenData } from '../cost-utils.ts';
import type { LoadedUsageEntry } from '../data-loader.ts';
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
import { extractProjectName, filterEntriesBySessionProjectFilters } from '../entry-filter.ts';
import { logger } from '../logger.ts';

const TABLE_COLUMN_COUNT = 6;
const MAX_SESSION_TITLE_CHARS = 40;

function truncateSessionTitle(title: string): string {
	if (title.length <= MAX_SESSION_TITLE_CHARS) {
		return title;
	}

	return `${title.slice(0, MAX_SESSION_TITLE_CHARS - 3)}...`;
}

type SessionBreakdown = ModelTokenData & {
	sessionID: string;
	sessionTitle: string;
	entries: LoadedUsageEntry[];
};

type ProjectBreakdown = ModelTokenData & {
	projectName: string;
	entries: LoadedUsageEntry[];
	sessions: SessionBreakdown[];
};

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
		full: {
			type: 'boolean',
			description: 'Show project/session breakdown rows',
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
				projectBreakdown: ProjectBreakdown[];
			}
		> = [];

		for (const [model, modelEntries] of Object.entries(entriesByModel)) {
			let inputTokens = 0;
			let outputTokens = 0;
			let reasoningTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let totalCost = 0;
			const projectBreakdownMap = new Map<
				string,
				{
					metrics: ModelTokenData;
					entries: LoadedUsageEntry[];
					sessions: Map<string, SessionBreakdown>;
				}
			>();

			for (const entry of modelEntries) {
				const cost = await calculateCostForEntry(entry, fetcher);
				inputTokens += entry.usage.inputTokens;
				outputTokens += entry.usage.outputTokens;
				reasoningTokens += entry.usage.reasoningTokens;
				cacheCreationTokens += entry.usage.cacheCreationInputTokens;
				cacheReadTokens += entry.usage.cacheReadInputTokens;
				totalCost += cost;

				const metadata = sessionMetadataMap.get(entry.sessionID);
				const projectName = extractProjectName(
					metadata?.directory ?? 'unknown',
					metadata?.projectID ?? '',
				);
				const sessionTitle = metadata?.title ?? entry.sessionID;

				let projectData = projectBreakdownMap.get(projectName);
				if (projectData == null) {
					projectData = {
						metrics: {
							inputTokens: 0,
							outputTokens: 0,
							reasoningTokens: 0,
							cacheCreationTokens: 0,
							cacheReadTokens: 0,
							totalCost: 0,
						},
						entries: [],
						sessions: new Map<string, SessionBreakdown>(),
					};
					projectBreakdownMap.set(projectName, projectData);
				}

				projectData.metrics.inputTokens += entry.usage.inputTokens;
				projectData.metrics.outputTokens += entry.usage.outputTokens;
				projectData.metrics.reasoningTokens += entry.usage.reasoningTokens;
				projectData.metrics.cacheCreationTokens += entry.usage.cacheCreationInputTokens;
				projectData.metrics.cacheReadTokens += entry.usage.cacheReadInputTokens;
				projectData.metrics.totalCost += cost;
				projectData.entries.push(entry);

				let sessionData = projectData.sessions.get(entry.sessionID);
				if (sessionData == null) {
					sessionData = {
						sessionID: entry.sessionID,
						sessionTitle,
						inputTokens: 0,
						outputTokens: 0,
						reasoningTokens: 0,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						totalCost: 0,
						entries: [],
					};
					projectData.sessions.set(entry.sessionID, sessionData);
				}

				sessionData.inputTokens += entry.usage.inputTokens;
				sessionData.outputTokens += entry.usage.outputTokens;
				sessionData.reasoningTokens += entry.usage.reasoningTokens;
				sessionData.cacheCreationTokens += entry.usage.cacheCreationInputTokens;
				sessionData.cacheReadTokens += entry.usage.cacheReadInputTokens;
				sessionData.totalCost += cost;
				sessionData.entries.push(entry);
			}

			const componentCosts = await calculateComponentCostsFromEntries(modelEntries, model, fetcher);
			const projectBreakdown = Array.from(projectBreakdownMap.entries())
				.map(([projectName, data]) => ({
					projectName,
					...data.metrics,
					entries: data.entries,
					sessions: Array.from(data.sessions.values()).sort((a, b) => b.totalCost - a.totalCost),
				}))
				.sort((a, b) => b.totalCost - a.totalCost);

			modelData.push({
				model,
				inputTokens,
				outputTokens,
				reasoningTokens,
				cacheCreationTokens,
				cacheReadTokens,
				totalCost,
				componentCosts,
				projectBreakdown,
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
							...(showBreakdown
								? {
										projectBreakdown: d.projectBreakdown.map((projectData) => ({
											projectName: projectData.projectName,
											inputTokens: totalInputTokens(projectData),
											outputTokens: projectData.outputTokens,
											reasoningTokens: projectData.reasoningTokens,
											cacheReadTokens: projectData.cacheReadTokens,
											totalCost: projectData.totalCost,
											sessions: projectData.sessions.map((sessionData) => ({
												sessionID: sessionData.sessionID,
												sessionTitle: sessionData.sessionTitle,
												inputTokens: totalInputTokens(sessionData),
												outputTokens: sessionData.outputTokens,
												reasoningTokens: sessionData.reasoningTokens,
												cacheReadTokens: sessionData.cacheReadTokens,
												totalCost: sessionData.totalCost,
											})),
										})),
									}
								: {}),
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

			if (showBreakdown) {
				for (const projectData of data.projectBreakdown) {
					const sessionCount = projectData.sessions.length;
					if (sessionCount === 1) {
						const sessionData = projectData.sessions[0];
						if (sessionData != null) {
							const truncatedSessionTitle = truncateSessionTitle(sessionData.sessionTitle);
							const sessionComponentCosts = await calculateComponentCostsFromEntries(
								sessionData.entries,
								data.model,
								fetcher,
							);

							table.push([
								`  ▸ ${projectData.projectName}/${truncatedSessionTitle}`,
								formatUncachedInputColumn(sessionData, sessionComponentCosts),
								formatCachedInputColumn(sessionData, sessionComponentCosts),
								formatInputColumn(sessionData, sessionComponentCosts),
								formatOutputColumn(sessionData, sessionComponentCosts),
								pc.green(formatCurrency(sessionData.totalCost)),
							]);
						}
						continue;
					}

					const projectComponentCosts = await calculateComponentCostsFromEntries(
						projectData.entries,
						data.model,
						fetcher,
					);

					table.push([
						`  ▸ ${projectData.projectName}`,
						formatUncachedInputColumn(projectData, projectComponentCosts),
						formatCachedInputColumn(projectData, projectComponentCosts),
						formatInputColumn(projectData, projectComponentCosts),
						formatOutputColumn(projectData, projectComponentCosts),
						pc.green(formatCurrency(projectData.totalCost)),
					]);

					for (const sessionData of projectData.sessions) {
						const truncatedSessionTitle = truncateSessionTitle(sessionData.sessionTitle);
						const sessionComponentCosts = await calculateComponentCostsFromEntries(
							sessionData.entries,
							data.model,
							fetcher,
						);

						table.push([
							`    - ${truncatedSessionTitle}\n${pc.dim(`      ${sessionData.sessionID}`)}`,
							formatUncachedInputColumn(sessionData, sessionComponentCosts),
							formatCachedInputColumn(sessionData, sessionComponentCosts),
							formatInputColumn(sessionData, sessionComponentCosts),
							formatOutputColumn(sessionData, sessionComponentCosts),
							pc.green(formatCurrency(sessionData.totalCost)),
						]);
					}
				}
			}
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
