import type { ComponentCosts, ModelTokenData } from '../cost-utils.ts';
import path from 'node:path';
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
	calculateComponentCosts,
	calculateCostForEntry,
	formatAggregateCacheColumn,
	formatCacheColumn,
	formatInputColumn,
	formatOutputColumn,
} from '../cost-utils.ts';
import { loadOpenCodeMessages, loadOpenCodeSessions } from '../data-loader.ts';
import { logger } from '../logger.ts';

const TABLE_COLUMN_COUNT = 6;
const MAX_SESSION_TITLE_CHARS = 40;

function truncateSessionTitle(title: string): string {
	if (title.length <= MAX_SESSION_TITLE_CHARS) {
		return title;
	}
	return `${title.slice(0, MAX_SESSION_TITLE_CHARS - 3)}...`;
}

function isValidDateArg(value: string): boolean {
	return /^\d{8}$/.test(value);
}

function toEntryDateKey(date: Date): string {
	return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function extractProjectName(directory: string, projectID: string): string {
	if (directory !== 'unknown' && directory.trim() !== '') {
		const base = path.basename(directory);
		if (base !== '') {
			return base;
		}
	}

	if (projectID.trim() !== '') {
		return projectID;
	}

	return 'unknown';
}

export const sessionCommand = define({
	name: 'session',
	description: 'Show OpenCode token usage grouped by session',
	args: {
		since: {
			type: 'string',
			description: 'Filter from date (YYYYMMDD format)',
		},
		until: {
			type: 'string',
			description: 'Filter until date (YYYYMMDD format)',
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
	},
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);
		const since = typeof ctx.values.since === 'string' ? ctx.values.since.trim() : '';
		const until = typeof ctx.values.until === 'string' ? ctx.values.until.trim() : '';

		if (since !== '' && !isValidDateArg(since)) {
			throw new Error(`Invalid --since value: ${since}. Use YYYYMMDD.`);
		}

		if (until !== '' && !isValidDateArg(until)) {
			throw new Error(`Invalid --until value: ${until}. Use YYYYMMDD.`);
		}

		if (since !== '' && until !== '' && since > until) {
			throw new Error('--since must be earlier than or equal to --until');
		}

		const [entries, sessionMetadataMap] = await Promise.all([
			loadOpenCodeMessages(),
			loadOpenCodeSessions(),
		]);

		const filteredEntries = entries.filter((entry) => {
			const dateKey = toEntryDateKey(entry.timestamp);
			if (since !== '' && dateKey < since) {
				return false;
			}
			if (until !== '' && dateKey > until) {
				return false;
			}
			return true;
		});

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
			cacheCreationTokens: number;
			cacheReadTokens: number;
			totalCost: number;
			modelsUsed: string[];
			lastActivity: Date;
			modelBreakdown: Record<string, ModelTokenData>;
		};

		const sessionData: SessionData[] = [];

		for (const [sessionID, sessionEntries] of Object.entries(entriesBySession)) {
			let inputTokens = 0;
			let outputTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let totalCost = 0;
			const modelsSet = new Set<string>();
			let lastActivity = sessionEntries[0]!.timestamp;
			const modelBreakdown: Record<string, ModelTokenData> = {};

			for (const entry of sessionEntries) {
				const cost = await calculateCostForEntry(entry, fetcher);
				inputTokens += entry.usage.inputTokens;
				outputTokens += entry.usage.outputTokens;
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
				cacheCreationTokens,
				cacheReadTokens,
				totalCost,
				modelsUsed: Array.from(modelsSet),
				lastActivity,
				modelBreakdown,
			});
		}

		sessionData.sort((a, b) => a.lastActivity.getTime() - b.lastActivity.getTime());

		const totals = {
			inputTokens: sessionData.reduce((sum, s) => sum + s.inputTokens, 0),
			outputTokens: sessionData.reduce((sum, s) => sum + s.outputTokens, 0),
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
			head: ['Session', 'Models', 'Input', 'Output', 'Cache', 'Cost (USD)'],
			colAligns: ['left', 'left', 'right', 'right', 'right', 'right'],
			compactHead: ['Session', 'Models', 'Input', 'Output', 'Cost (USD)'],
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

			const parentInput =
				parentSession.inputTokens +
				parentSession.cacheCreationTokens +
				parentSession.cacheReadTokens;

			// Session summary row (no $/M — may have mixed models)
			table.push([
				parentSessionCell,
				formatModelsDisplayMultiline(parentSession.modelsUsed),
				formatNumber(parentInput),
				formatNumber(parentSession.outputTokens),
				formatAggregateCacheColumn(
					parentSession.inputTokens,
					parentSession.cacheCreationTokens,
					parentSession.cacheReadTokens,
				),
				formatCurrency(parentSession.totalCost),
			]);

			// Per-model breakdown rows (with $/M rates)
			const sortedParentModels = Object.entries(parentSession.modelBreakdown).sort(
				(a, b) => b[1].totalCost - a[1].totalCost,
			);

			for (const [model, metrics] of sortedParentModels) {
				const componentCosts: ComponentCosts = await calculateComponentCosts(
					metrics,
					model,
					fetcher,
				);

				table.push([
					pc.dim(`  - ${model}`),
					'',
					formatInputColumn(metrics, componentCosts),
					formatOutputColumn(metrics, componentCosts),
					formatCacheColumn(metrics),
					pc.dim(formatCurrency(metrics.totalCost)),
				]);
			}

			const subSessions = sessionsByParent[parentSession.sessionID];
			if (subSessions != null && subSessions.length > 0) {
				for (const subSession of subSessions) {
					const subTitle = truncateSessionTitle(subSession.sessionTitle);
					const subSessionCell = `  ↳ ${subTitle}\n${pc.dim(`    ${subSession.projectName}`)}`;
					const subInput =
						subSession.inputTokens + subSession.cacheCreationTokens + subSession.cacheReadTokens;

					table.push([
						subSessionCell,
						formatModelsDisplayMultiline(subSession.modelsUsed),
						formatNumber(subInput),
						formatNumber(subSession.outputTokens),
						formatAggregateCacheColumn(
							subSession.inputTokens,
							subSession.cacheCreationTokens,
							subSession.cacheReadTokens,
						),
						formatCurrency(subSession.totalCost),
					]);

					// Per-model breakdown for sub-session (with $/M rates)
					const sortedSubModels = Object.entries(subSession.modelBreakdown).sort(
						(a, b) => b[1].totalCost - a[1].totalCost,
					);

					for (const [model, metrics] of sortedSubModels) {
						const componentCosts: ComponentCosts = await calculateComponentCosts(
							metrics,
							model,
							fetcher,
						);

						table.push([
							pc.dim(`    - ${model}`),
							'',
							formatInputColumn(metrics, componentCosts),
							formatOutputColumn(metrics, componentCosts),
							formatCacheColumn(metrics),
							pc.dim(formatCurrency(metrics.totalCost)),
						]);
					}
				}

				const subtotalInputTokens =
					parentSession.inputTokens + subSessions.reduce((sum, s) => sum + s.inputTokens, 0);
				const subtotalOutputTokens =
					parentSession.outputTokens + subSessions.reduce((sum, s) => sum + s.outputTokens, 0);
				const subtotalCacheCreationTokens =
					parentSession.cacheCreationTokens +
					subSessions.reduce((sum, s) => sum + s.cacheCreationTokens, 0);
				const subtotalCacheReadTokens =
					parentSession.cacheReadTokens +
					subSessions.reduce((sum, s) => sum + s.cacheReadTokens, 0);
				const subtotalCost =
					parentSession.totalCost + subSessions.reduce((sum, s) => sum + s.totalCost, 0);

				const subtotalInput =
					subtotalInputTokens + subtotalCacheCreationTokens + subtotalCacheReadTokens;

				table.push([
					pc.dim('  Total (with subagents)'),
					'',
					pc.yellow(formatNumber(subtotalInput)),
					pc.yellow(formatNumber(subtotalOutputTokens)),
					pc.yellow(
						formatAggregateCacheColumn(
							subtotalInputTokens,
							subtotalCacheCreationTokens,
							subtotalCacheReadTokens,
						),
					),
					pc.yellow(formatCurrency(subtotalCost)),
				]);
			}
		}

		const totalInput = totals.inputTokens + totals.cacheCreationTokens + totals.cacheReadTokens;

		addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);
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
