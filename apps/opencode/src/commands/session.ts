import type { ComponentCosts, ModelTokenData } from '../cost-utils.ts';
import type { LoadedUsageEntry } from '../data-loader.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { formatModelsDisplayMultiline } from '@ccusage/terminal/table';
import { groupBy } from 'es-toolkit';
import { define } from 'gunshi';
import pc from 'picocolors';
import {
	calculateComponentCostsFromEntries,
	calculateCostForEntry,
} from '../cost-utils.ts';
import { loadOpenCodeMessages, loadOpenCodeSessions } from '../data-loader.ts';
import { filterEntriesByDateRange, resolveDateRangeFilters } from '../date-filter.ts';
import { extractProjectName, filterEntriesBySessionProjectFilters } from '../entry-filter.ts';
import { logger } from '../logger.ts';
import { createModelLabelResolver, formatModelLabelForTable } from '../model-display.ts';
import {
	buildAggregateSummaryRow,
	buildModelBreakdownRow,
	createUsageTable,
	isCompactTable,
	remapTokensForAggregate,
} from '../usage-table.ts';
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
		subagents: {
			type: 'boolean',
			description: 'Show subagent sessions',
		},
	},
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);
		const showBreakdown = ctx.values.full === true;
		const showSubagents = ctx.values.subagents === true;
		const showProviders = ctx.values.providers === true;
		const idInput = typeof ctx.values.id === 'string' ? ctx.values.id.trim() : '';
		const projectInput = typeof ctx.values.project === 'string' ? ctx.values.project.trim() : '';
		const modelInput = typeof ctx.values.model === 'string' ? ctx.values.model.trim() : '';
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
				modelInput,
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
		const modelLabelForEntry = createModelLabelResolver(
			filteredEntries,
			showProviders ? 'always' : 'never',
		);

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

				if (entry.timestamp > lastActivity) {
					lastActivity = entry.timestamp;
				}

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

		sessionData.sort(
			(a, b) => b.totalCost - a.totalCost || b.lastActivity.getTime() - a.lastActivity.getTime(),
		);

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

		const table = createUsageTable({
			firstColumnName: 'Session',
			hasModelsColumn: true,
			forceCompact: Boolean(ctx.values.compact),
		});
		const compact = isCompactTable(table);

		const sessionsByParent = groupBy(sessionData, (s) => s.parentID ?? 'root');
		const parentSessions = [...(sessionsByParent.root ?? [])].sort(
			(a, b) => b.totalCost - a.totalCost || b.lastActivity.getTime() - a.lastActivity.getTime(),
		);
		delete sessionsByParent.root;

		for (const parentSession of parentSessions) {
			const isParent = sessionsByParent[parentSession.sessionID] != null;
			const parentTitle = truncateSessionTitle(parentSession.sessionTitle);
			const displayTitle = isParent ? pc.bold(parentTitle) : parentTitle;
			const parentSessionCell = `${displayTitle}\n${pc.dim(`${parentSession.projectName}/${parentSession.sessionID}`)}`;

			// Session summary row (no $/M — may have mixed models)
			table.push(
				buildAggregateSummaryRow(
					parentSessionCell,
					formatModelsDisplayMultiline(parentSession.modelsUsed),
					parentSession,
					{ compact },
				),
			);

			if (showBreakdown && !compact) {
				const sortedParentModels = Object.entries(parentSession.modelBreakdown).sort(
					(a, b) => b[1].totalCost - a[1].totalCost,
				);

				for (const [model, metrics] of sortedParentModels) {
					const modelEntries = breakdownEntriesBySession[parentSession.sessionID]?.[model] ?? [];
					const pricingModel = modelEntries[0]?.model ?? model;
					const componentCosts: ComponentCosts = await calculateComponentCostsFromEntries(
						modelEntries,
						pricingModel,
						fetcher,
					);

					// Session puts model label in first column, empty models column
					table.push(
						buildModelBreakdownRow(formatModelLabelForTable(model), '', metrics, componentCosts),
					);
				}
			}

			const subSessions = showSubagents
				? [...(sessionsByParent[parentSession.sessionID] ?? [])].sort(
						(a, b) =>
							b.totalCost - a.totalCost || b.lastActivity.getTime() - a.lastActivity.getTime(),
					)
				: undefined;
			if (subSessions != null && subSessions.length > 0) {
				for (const subSession of subSessions) {
					const subTitle = truncateSessionTitle(subSession.sessionTitle);
					const subSessionCell = `  ↳ ${subTitle}\n${pc.dim(`    ${subSession.projectName}/${subSession.sessionID}`)}`;

					table.push(
						buildAggregateSummaryRow(
							subSessionCell,
							formatModelsDisplayMultiline(subSession.modelsUsed),
							subSession,
							{ compact },
						),
					);

					if (showBreakdown && !compact) {
						const sortedSubModels = Object.entries(subSession.modelBreakdown).sort(
							(a, b) => b[1].totalCost - a[1].totalCost,
						);

						for (const [model, metrics] of sortedSubModels) {
							const modelEntries = breakdownEntriesBySession[subSession.sessionID]?.[model] ?? [];
							const pricingModel = modelEntries[0]?.model ?? model;
							const componentCosts: ComponentCosts = await calculateComponentCostsFromEntries(
								modelEntries,
								pricingModel,
								fetcher,
							);

							table.push(
								buildModelBreakdownRow(formatModelLabelForTable(model), '', metrics, componentCosts),
							);
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

				table.push(
					buildAggregateSummaryRow(
						pc.dim('  Total (with subagents)'),
						'',
						{
							inputTokens: subtotalInputTokens,
							outputTokens: subtotalOutputTokens,
							reasoningTokens: subtotalReasoningTokens,
							cacheCreationTokens: subtotalCacheCreationTokens,
							cacheReadTokens: subtotalCacheReadTokens,
							totalCost: subtotalCost,
						},
						{ yellow: true, compact },
					),
				);
			}
		}

		table.push(
			buildAggregateSummaryRow('Total', '', totals, { yellow: true, compact }),
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
