import type { ComponentCosts, ModelTokenData } from '../cost-utils.ts';
import type { LoadedUsageEntry } from '../data-loader.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import {
	addEmptySeparatorRow,
	formatCurrency,
	formatDateCompact,
	formatModelsDisplayMultiline,
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

const TABLE_COLUMN_COUNT = 7;
const MAX_SESSION_TITLE_CHARS = 40;

function truncateSessionTitle(title: string): string {
	if (title.length <= MAX_SESSION_TITLE_CHARS) {
		return title;
	}
	return `${title.slice(0, MAX_SESSION_TITLE_CHARS - 3)}...`;
}

export const sessionCommand = define({
	name: 'session',
	description: 'Show OpenCode token usage grouped by session',
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
		subagents: {
			type: 'boolean',
			description: 'Show subagent sessions',
		},
	},
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);
		const showBreakdown = ctx.values.full === true;
		const showSubagents = ctx.values.subagents === true;
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
				? JSON.stringify({ sessions: [], totals: null })
				: 'No OpenCode usage data found.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		using fetcher = new LiteLLMPricingFetcher({ offline: false, logger });

		const entriesBySession = groupBy(filteredEntries, (entry) => entry.sessionID);

		type SessionData = {
			sessionID: string;
			sessionTitle: string;
			projectName: string;
			parentID: string | null;
			inputTokens: number;
			outputTokens: number;
			reasoningTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			totalCost: number;
			modelsUsed: string[];
			lastActivity: Date;
			modelBreakdown: Record<string, ModelTokenData>;
		};

		const sessionData: SessionData[] = [];
		const breakdownEntriesBySession: Record<string, Record<string, LoadedUsageEntry[]>> = {};

		for (const [sessionID, sessionEntries] of Object.entries(entriesBySession)) {
			let inputTokens = 0;
			let outputTokens = 0;
			let reasoningTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let totalCost = 0;
			const modelsSet = new Set<string>();
			let lastActivity = sessionEntries[0]!.timestamp;
			const modelBreakdown: Record<string, ModelTokenData> = {};
			const modelEntriesByModel: Record<string, LoadedUsageEntry[]> = {};

			for (const entry of sessionEntries) {
				const cost = await calculateCostForEntry(entry, fetcher);
				inputTokens += entry.usage.inputTokens;
				outputTokens += entry.usage.outputTokens;
				reasoningTokens += entry.usage.reasoningTokens;
				cacheCreationTokens += entry.usage.cacheCreationInputTokens;
				cacheReadTokens += entry.usage.cacheReadInputTokens;
				totalCost += cost;
				modelsSet.add(entry.model);

				if (entry.timestamp > lastActivity) {
					lastActivity = entry.timestamp;
				}

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

				let modelEntries = modelEntriesByModel[entry.model];
				if (modelEntries == null) {
					modelEntries = [];
					modelEntriesByModel[entry.model] = modelEntries;
				}
				modelEntries.push(entry);
			}

			const metadata = sessionMetadataMap.get(sessionID);

			sessionData.push({
				sessionID,
				sessionTitle: metadata?.title ?? sessionID,
				projectName: extractProjectName(
					metadata?.directory ?? 'unknown',
					metadata?.projectID ?? '',
				),
				parentID: metadata?.parentID ?? null,
				inputTokens,
				outputTokens,
				reasoningTokens,
				cacheCreationTokens,
				cacheReadTokens,
				totalCost,
				modelsUsed: Array.from(modelsSet),
				lastActivity,
				modelBreakdown,
			});
			breakdownEntriesBySession[sessionID] = modelEntriesByModel;
		}

		sessionData.sort((a, b) => a.lastActivity.getTime() - b.lastActivity.getTime());

		const totals = {
			inputTokens: sessionData.reduce((sum, s) => sum + s.inputTokens, 0),
			outputTokens: sessionData.reduce((sum, s) => sum + s.outputTokens, 0),
			reasoningTokens: sessionData.reduce((sum, s) => sum + s.reasoningTokens, 0),
			cacheCreationTokens: sessionData.reduce((sum, s) => sum + s.cacheCreationTokens, 0),
			cacheReadTokens: sessionData.reduce((sum, s) => sum + s.cacheReadTokens, 0),
			totalCost: sessionData.reduce((sum, s) => sum + s.totalCost, 0),
		};
		if (jsonOutput) {
			// eslint-disable-next-line no-console
			console.log(
				JSON.stringify(
					{
						sessions: sessionData,
						totals,
					},
					null,
					2,
				),
			);
			return;
		}

		// eslint-disable-next-line no-console
		console.log('\n📊 OpenCode Token Usage Report - Sessions\n');

		const table: ResponsiveTable = new ResponsiveTable({
			head: [
				'Session',
				'Models',
				'Input Uncached',
				'Input Cached',
				'Input Total',
				'Output/Reasoning%',
				'Cost (USD)',
			],
			colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right'],
			compactHead: ['Session', 'Models', 'Input Total', 'Output/Reasoning%', 'Cost (USD)'],
			compactColAligns: ['left', 'left', 'right', 'right', 'right'],
			compactThreshold: 90,
			forceCompact: Boolean(ctx.values.compact),
			style: { head: ['cyan'] },
			dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
		});

		const sessionsByParent = groupBy(sessionData, (s) => s.parentID ?? 'root');
		const parentSessions = sessionsByParent.root ?? [];
		delete sessionsByParent.root;

		for (const parentSession of parentSessions) {
			const isParent = sessionsByParent[parentSession.sessionID] != null;
			const parentTitle = truncateSessionTitle(parentSession.sessionTitle);
			const displayTitle = isParent ? pc.bold(parentTitle) : parentTitle;
			const parentSessionCell = `${displayTitle}\n${pc.dim(parentSession.projectName)}`;

			const parentInput = totalInputTokens(parentSession);
			const parentOutputDisplay = formatOutputValueWithReasoningPct(
				parentSession.outputTokens,
				parentSession.reasoningTokens,
			);

			// Session summary row (no $/M — may have mixed models)
			table.push([
				parentSessionCell,
				formatModelsDisplayMultiline(parentSession.modelsUsed),
				formatAggregateUncachedInputColumn(
					parentSession.inputTokens,
					parentSession.cacheCreationTokens,
					parentSession.cacheReadTokens,
				),
				formatAggregateCachedInputColumn(
					parentSession.inputTokens,
					parentSession.cacheCreationTokens,
					parentSession.cacheReadTokens,
				),
				formatNumber(parentInput),
				parentOutputDisplay,
				pc.green(formatCurrency(parentSession.totalCost)),
			]);

			if (showBreakdown) {
				// Per-model breakdown rows (with $/M rates)
				const sortedParentModels = Object.entries(parentSession.modelBreakdown).sort(
					(a, b) => b[1].totalCost - a[1].totalCost,
				);

				for (const [model, metrics] of sortedParentModels) {
					const modelEntries = breakdownEntriesBySession[parentSession.sessionID]?.[model] ?? [];
					const componentCosts: ComponentCosts = await calculateComponentCostsFromEntries(
						modelEntries,
						model,
						fetcher,
					);

					table.push([
						`  - ${model}`,
						'',
						formatUncachedInputColumn(metrics, componentCosts),
						formatCachedInputColumn(metrics, componentCosts),
						formatInputColumn(metrics, componentCosts),
						formatOutputColumn(metrics, componentCosts),
						pc.green(formatCurrency(metrics.totalCost)),
					]);
				}
			}

			const subSessions = showSubagents ? sessionsByParent[parentSession.sessionID] : undefined;
			if (subSessions != null && subSessions.length > 0) {
				for (const subSession of subSessions) {
					const subTitle = truncateSessionTitle(subSession.sessionTitle);
					const subSessionCell = `  ↳ ${subTitle}\n${pc.dim(`    ${subSession.projectName}`)}`;
					const subInput = totalInputTokens(subSession);
					const subOutputDisplay = formatOutputValueWithReasoningPct(
						subSession.outputTokens,
						subSession.reasoningTokens,
					);

					table.push([
						subSessionCell,
						formatModelsDisplayMultiline(subSession.modelsUsed),
						formatAggregateUncachedInputColumn(
							subSession.inputTokens,
							subSession.cacheCreationTokens,
							subSession.cacheReadTokens,
						),
						formatAggregateCachedInputColumn(
							subSession.inputTokens,
							subSession.cacheCreationTokens,
							subSession.cacheReadTokens,
						),
						formatNumber(subInput),
						subOutputDisplay,
						pc.green(formatCurrency(subSession.totalCost)),
					]);

					if (showBreakdown) {
						// Per-model breakdown for sub-session (with $/M rates)
						const sortedSubModels = Object.entries(subSession.modelBreakdown).sort(
							(a, b) => b[1].totalCost - a[1].totalCost,
						);

						for (const [model, metrics] of sortedSubModels) {
							const modelEntries = breakdownEntriesBySession[subSession.sessionID]?.[model] ?? [];
							const componentCosts: ComponentCosts = await calculateComponentCostsFromEntries(
								modelEntries,
								model,
								fetcher,
							);

							table.push([
								`    - ${model}`,
								'',
								formatUncachedInputColumn(metrics, componentCosts),
								formatCachedInputColumn(metrics, componentCosts),
								formatInputColumn(metrics, componentCosts),
								formatOutputColumn(metrics, componentCosts),
								pc.green(formatCurrency(metrics.totalCost)),
							]);
						}
					}
				}

				const subtotalInputTokens =
					parentSession.inputTokens + subSessions.reduce((sum, s) => sum + s.inputTokens, 0);
				const subtotalOutputTokens =
					parentSession.outputTokens + subSessions.reduce((sum, s) => sum + s.outputTokens, 0);
				const subtotalReasoningTokens =
					parentSession.reasoningTokens +
					subSessions.reduce((sum, s) => sum + s.reasoningTokens, 0);
				const subtotalCacheCreationTokens =
					parentSession.cacheCreationTokens +
					subSessions.reduce((sum, s) => sum + s.cacheCreationTokens, 0);
				const subtotalCacheReadTokens =
					parentSession.cacheReadTokens +
					subSessions.reduce((sum, s) => sum + s.cacheReadTokens, 0);
				const subtotalCost =
					parentSession.totalCost + subSessions.reduce((sum, s) => sum + s.totalCost, 0);

				const subtotalUncachedInput = subtotalInputTokens + subtotalCacheCreationTokens;
				const subtotalInput = subtotalUncachedInput + subtotalCacheReadTokens;

				table.push([
					pc.dim('  Total (with subagents)'),
					'',
					pc.yellow(
						formatAggregateUncachedInputColumn(
							subtotalInputTokens,
							subtotalCacheCreationTokens,
							subtotalCacheReadTokens,
						),
					),
					pc.yellow(
						formatAggregateCachedInputColumn(
							subtotalInputTokens,
							subtotalCacheCreationTokens,
							subtotalCacheReadTokens,
						),
					),
					pc.yellow(formatNumber(subtotalInput)),
					pc.yellow(
						formatOutputValueWithReasoningPct(subtotalOutputTokens, subtotalReasoningTokens),
					),
					pc.yellow(pc.green(formatCurrency(subtotalCost))),
				]);
			}
		}

		const totalInput = totalInputTokens(totals);

		addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);
		table.push([
			pc.yellow('Total'),
			'',
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
