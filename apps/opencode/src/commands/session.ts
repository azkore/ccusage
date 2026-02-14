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
import { calculateCostForEntry } from '../cost-utils.ts';
import { loadOpenCodeMessages, loadOpenCodeSessions } from '../data-loader.ts';
import { logger } from '../logger.ts';

const TABLE_COLUMN_COUNT = 8;

export const sessionCommand = define({
	name: 'session',
	description: 'Show OpenCode token usage grouped by session',
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

		const [entries, sessionMetadataMap] = await Promise.all([
			loadOpenCodeMessages(),
			loadOpenCodeSessions(),
		]);

		if (entries.length === 0) {
			const output = jsonOutput
				? JSON.stringify({ sessions: [], totals: null })
				: 'No OpenCode usage data found.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		using fetcher = new LiteLLMPricingFetcher({ offline: false, logger });

		const entriesBySession = groupBy(entries, (entry) => entry.sessionID);

		type SessionData = {
			sessionID: string;
			sessionTitle: string;
			parentID: string | null;
			inputTokens: number;
			outputTokens: number;
			cacheCreationTokens: number;
			cacheReadTokens: number;
			totalTokens: number;
			totalCost: number;
			modelsUsed: string[];
			lastActivity: Date;
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

			const totalTokens = inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens;

			const metadata = sessionMetadataMap.get(sessionID);

			sessionData.push({
				sessionID,
				sessionTitle: metadata?.title ?? sessionID,
				parentID: metadata?.parentID ?? null,
				inputTokens,
				outputTokens,
				cacheCreationTokens,
				cacheReadTokens,
				totalTokens,
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
			totalTokens: sessionData.reduce((sum, s) => sum + s.totalTokens, 0),
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
				'Input',
				'Output',
				'Cache Create',
				'Cache Read',
				'Total Tokens',
				'Cost (USD)',
			],
			colAligns: ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
			compactHead: ['Session', 'Models', 'Input', 'Output', 'Cost (USD)'],
			compactColAligns: ['left', 'left', 'right', 'right', 'right'],
			compactThreshold: 100,
			forceCompact: Boolean(ctx.values.compact),
			style: { head: ['cyan'] },
			dateFormatter: (dateStr: string) => formatDateCompact(dateStr),
		});

		const sessionsByParent = groupBy(sessionData, (s) => s.parentID ?? 'root');
		const parentSessions = sessionsByParent.root ?? [];
		delete sessionsByParent.root;

		for (const parentSession of parentSessions) {
			const isParent = sessionsByParent[parentSession.sessionID] != null;
			const displayTitle = isParent
				? pc.bold(parentSession.sessionTitle)
				: parentSession.sessionTitle;

			// Calculate cache hit rate for parent session
			const parentCacheHitRate =
				parentSession.inputTokens + parentSession.cacheReadTokens > 0
					? (parentSession.cacheReadTokens /
							(parentSession.inputTokens + parentSession.cacheReadTokens)) *
						100
					: 0;
			const parentCacheReadDisplay = `${formatNumber(parentSession.cacheReadTokens)}${
				parentCacheHitRate > 0 ? ` (${parentCacheHitRate.toFixed(0)}%)` : ''
			}`;

			table.push([
				displayTitle,
				formatModelsDisplayMultiline(parentSession.modelsUsed),
				formatNumber(parentSession.inputTokens),
				formatNumber(parentSession.outputTokens),
				formatNumber(parentSession.cacheCreationTokens),
				parentCacheReadDisplay,
				formatNumber(parentSession.totalTokens),
				formatCurrency(parentSession.totalCost),
			]);

			// Breakdown for parent session
			const sortedParentModels = Object.entries(parentSession.modelBreakdown).sort(
				(a, b) => b[1].totalCost - a[1].totalCost,
			);

			for (const [model, metrics] of sortedParentModels) {
				const totalModelTokens =
					metrics.inputTokens +
					metrics.outputTokens +
					metrics.cacheCreationTokens +
					metrics.cacheReadTokens;

				const modelHitRate =
					metrics.inputTokens + metrics.cacheReadTokens > 0
						? (metrics.cacheReadTokens / (metrics.inputTokens + metrics.cacheReadTokens)) * 100
						: 0;
				const modelCacheReadDisplay = `${formatNumber(metrics.cacheReadTokens)}${
					modelHitRate > 0 ? ` (${modelHitRate.toFixed(0)}%)` : ''
				}`;

				table.push([
					pc.dim(`  - ${model}`),
					'',
					pc.dim(formatNumber(metrics.inputTokens)),
					pc.dim(formatNumber(metrics.outputTokens)),
					pc.dim(formatNumber(metrics.cacheCreationTokens)),
					pc.dim(modelCacheReadDisplay),
					pc.dim(formatNumber(totalModelTokens)),
					pc.dim(formatCurrency(metrics.totalCost)),
				]);
			}

			const subSessions = sessionsByParent[parentSession.sessionID];
			if (subSessions != null && subSessions.length > 0) {
				for (const subSession of subSessions) {
					// Calculate cache hit rate for sub-session
					const subCacheHitRate =
						subSession.inputTokens + subSession.cacheReadTokens > 0
							? (subSession.cacheReadTokens /
									(subSession.inputTokens + subSession.cacheReadTokens)) *
								100
							: 0;
					const subCacheReadDisplay = `${formatNumber(subSession.cacheReadTokens)}${
						subCacheHitRate > 0 ? ` (${subCacheHitRate.toFixed(0)}%)` : ''
					}`;

					table.push([
						`  ↳ ${subSession.sessionTitle}`,
						formatModelsDisplayMultiline(subSession.modelsUsed),
						formatNumber(subSession.inputTokens),
						formatNumber(subSession.outputTokens),
						formatNumber(subSession.cacheCreationTokens),
						subCacheReadDisplay,
						formatNumber(subSession.totalTokens),
						formatCurrency(subSession.totalCost),
					]);

					// Breakdown for sub-session
					const sortedSubModels = Object.entries(subSession.modelBreakdown).sort(
						(a, b) => b[1].totalCost - a[1].totalCost,
					);

					for (const [model, metrics] of sortedSubModels) {
						const totalModelTokens =
							metrics.inputTokens +
							metrics.outputTokens +
							metrics.cacheCreationTokens +
							metrics.cacheReadTokens;

						const subModelHitRate =
							metrics.inputTokens + metrics.cacheReadTokens > 0
								? (metrics.cacheReadTokens / (metrics.inputTokens + metrics.cacheReadTokens)) * 100
								: 0;
						const subModelCacheReadDisplay = `${formatNumber(metrics.cacheReadTokens)}${
							subModelHitRate > 0 ? ` (${subModelHitRate.toFixed(0)}%)` : ''
						}`;

						table.push([
							pc.dim(`    - ${model}`),
							'',
							pc.dim(formatNumber(metrics.inputTokens)),
							pc.dim(formatNumber(metrics.outputTokens)),
							pc.dim(formatNumber(metrics.cacheCreationTokens)),
							pc.dim(subModelCacheReadDisplay),
							pc.dim(formatNumber(totalModelTokens)),
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
				const subtotalTotalTokens =
					parentSession.totalTokens + subSessions.reduce((sum, s) => sum + s.totalTokens, 0);
				const subtotalCost =
					parentSession.totalCost + subSessions.reduce((sum, s) => sum + s.totalCost, 0);

				const subtotalHitRate =
					subtotalInputTokens + subtotalCacheReadTokens > 0
						? (subtotalCacheReadTokens / (subtotalInputTokens + subtotalCacheReadTokens)) * 100
						: 0;
				const subtotalCacheReadDisplay = `${formatNumber(subtotalCacheReadTokens)}${
					subtotalHitRate > 0 ? ` (${subtotalHitRate.toFixed(0)}%)` : ''
				}`;

				table.push([
					pc.dim('  Total (with subagents)'),
					'',
					pc.yellow(formatNumber(subtotalInputTokens)),
					pc.yellow(formatNumber(subtotalOutputTokens)),
					pc.yellow(formatNumber(subtotalCacheCreationTokens)),
					pc.yellow(subtotalCacheReadDisplay),
					pc.yellow(formatNumber(subtotalTotalTokens)),
					pc.yellow(formatCurrency(subtotalCost)),
				]);
			}
		}

		const totalHitRate =
			totals.inputTokens + totals.cacheReadTokens > 0
				? (totals.cacheReadTokens / (totals.inputTokens + totals.cacheReadTokens)) * 100
				: 0;
		const totalCacheReadDisplay = `${formatNumber(totals.cacheReadTokens)}${
			totalHitRate > 0 ? ` (${totalHitRate.toFixed(0)}%)` : ''
		}`;

		addEmptySeparatorRow(table, TABLE_COLUMN_COUNT);
		table.push([
			pc.yellow('Total'),
			'',
			pc.yellow(formatNumber(totals.inputTokens)),
			pc.yellow(formatNumber(totals.outputTokens)),
			pc.yellow(formatNumber(totals.cacheCreationTokens)),
			pc.yellow(totalCacheReadDisplay),
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
