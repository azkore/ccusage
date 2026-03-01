import type { ComponentCosts, ModelTokenData } from '../cost-utils.ts';
import type { LoadedUsageEntry } from '../data-loader.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { formatModelsDisplayMultiline } from '@ccusage/terminal/table';
import { groupBy } from 'es-toolkit';
import { define } from 'gunshi';
import pc from 'picocolors';
import {
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
const MAX_SESSION_TITLE_CHARS = 40;

function truncateSessionTitle(title: string): string {
	if (title.length <= MAX_SESSION_TITLE_CHARS) {
		return title;
	}
	return `${title.slice(0, MAX_SESSION_TITLE_CHARS - 3)}...`;
}

export const sessionCommand = define({
	name: 'session',
	description:
		'Show OpenCode token usage grouped by session. Use --breakdown model,cost for per-model rate details ($/M→$...).',
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
				"Choose breakdown dimensions (comma-separated): source, provider, model, full-model, cost, percent, project. Use 'none' to disable.",
		},
		'skip-zero': {
			type: 'boolean',
			description: 'Hide rows whose cost rounds to $0.00',
		},
		subagents: {
			type: 'boolean',
			description: 'Show subagent sessions',
		},
	},
	async run(ctx) {
		const jsonOutput = Boolean(ctx.values.json);
		const skipZero = ctx.values['skip-zero'] === true;
		const showSubagents = ctx.values.subagents === true;
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
		const breakdowns = resolveBreakdownDimensions({
			full: ctx.values.full === true,
			breakdownInput,
			available: ['source', 'provider', 'model', 'full-model', 'cost', 'percent', 'project'],
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
		const sinceInput = typeof ctx.values.since === 'string' ? ctx.values.since.trim() : '';
		const untilInput = typeof ctx.values.until === 'string' ? ctx.values.until.trim() : '';
		const lastInput = typeof ctx.values.last === 'string' ? ctx.values.last.trim() : '';
		const { sinceDate, untilDate } = resolveDateRangeFilters({
			sinceInput,
			untilInput,
			lastInput,
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
				? JSON.stringify({ source, sessions: [], totals: null })
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
		const entryCostMap = new Map<LoadedUsageEntry, number>();

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

			for (const entry of sessionEntries) {
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
		}

		sessionData.sort(
			(a, b) => b.totalCost - a.totalCost || b.lastActivity.getTime() - a.lastActivity.getTime(),
		);

		const visibleSessionData = skipZero
			? sessionData.filter((session) => !isDisplayedZeroCost(session.totalCost))
			: sessionData;

		if (visibleSessionData.length === 0) {
			const output = jsonOutput
				? JSON.stringify({ source, sessions: [], totals: null })
				: 'No usage rows found after applying --skip-zero.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		const totals = {
			inputTokens: visibleSessionData.reduce((sum, s) => sum + s.inputTokens, 0),
			outputTokens: visibleSessionData.reduce((sum, s) => sum + s.outputTokens, 0),
			reasoningTokens: visibleSessionData.reduce((sum, s) => sum + s.reasoningTokens, 0),
			cacheCreationTokens: visibleSessionData.reduce((sum, s) => sum + s.cacheCreationTokens, 0),
			cacheReadTokens: visibleSessionData.reduce((sum, s) => sum + s.cacheReadTokens, 0),
			totalCost: visibleSessionData.reduce((sum, s) => sum + s.totalCost, 0),
		};
		if (jsonOutput) {
			// eslint-disable-next-line no-console
			console.log(
				JSON.stringify(
					{
						source,
						sessions: visibleSessionData,
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
		console.log(`\n📊 ${sourceLabel} Token Usage Report - Sessions\n`);

		const table = createUsageTable({
			firstColumnName: 'Session',
			hasModelsColumn: true,
			forceCompact: Boolean(ctx.values.compact),
		});
		const compact = isCompactTable(table);

		const aggregateEntries = (entries: LoadedUsageEntry[]) => {
			let inputTokens = 0;
			let outputTokens = 0;
			let reasoningTokens = 0;
			let cacheCreationTokens = 0;
			let cacheReadTokens = 0;
			let totalCost = 0;
			const modelBreakdown: Record<string, ModelTokenData> = {};

			for (const entry of entries) {
				const modelLabel = modelLabelForEntry(entry);
				const mapped = remapTokensForAggregate(entry.usage);
				inputTokens += mapped.base;
				outputTokens += entry.usage.outputTokens;
				reasoningTokens += entry.usage.reasoningTokens;
				cacheCreationTokens += mapped.cacheCreate;
				cacheReadTokens += mapped.cacheRead;
				totalCost += entryCostMap.get(entry) ?? 0;

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
				mb.totalCost += entryCostMap.get(entry) ?? 0;
			}

			return {
				inputTokens,
				outputTokens,
				reasoningTokens,
				cacheCreationTokens,
				cacheReadTokens,
				totalCost,
				modelBreakdown,
			};
		};

		const pushBreakdownRowsForSession = async (sessionID: string, prefix: string) => {
			if (compact || !showBreakdown) {
				return;
			}

			const sessionEntries = entriesBySession[sessionID] ?? [];
			const groupedEntries = groupBy(sessionEntries, (entry) => {
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

				return keyParts.join('\u001F');
			});

			const rows = Object.entries(groupedEntries)
				.map(([groupKey, entries]) => ({
					label: groupKey.split('\u001F').join('/'),
					entries,
					aggregate: aggregateEntries(entries),
				}))
				.filter((row) => !skipZero || !isDisplayedZeroCost(row.aggregate.totalCost))
				.sort((a, b) => b.aggregate.totalCost - a.aggregate.totalCost);

			for (const row of rows) {
				const modelMetricsValues = Object.values(row.aggregate.modelBreakdown);
				if (
					includeCost &&
					(includeModel || includeFullModel) &&
					groupingBreakdowns.length === 1 &&
					modelMetricsValues.length === 1
				) {
					const modelMetrics = modelMetricsValues[0];
					if (modelMetrics != null) {
						const pricingModel = row.entries[0]?.model ?? row.label;
						const componentCosts: ComponentCosts = await calculateComponentCostsFromEntries(
							row.entries,
							pricingModel,
							fetcher,
						);

						table.push(
							buildModelBreakdownRow(
								`${prefix}${formatModelLabelForTable(row.label)}`,
								'',
								modelMetrics,
								componentCosts,
								{ showPercent: includePercent },
							),
						);
						continue;
					}
				}

				table.push(
					buildAggregateSummaryRow(
						`${prefix}${row.label}`,
						'',
						row.aggregate,
						includeCost
							? {
									compact,
									showPercent: includePercent,
									columnCosts: await calculateAggregateComponentCostsFromEntries(
										row.entries,
										fetcher,
									),
								}
							: { compact, showPercent: includePercent },
					),
				);
			}
		};

		const visibleSessionIDs = new Set(visibleSessionData.map((session) => session.sessionID));
		const sessionsByParent = groupBy(visibleSessionData, (session) => {
			if (session.parentID == null || !visibleSessionIDs.has(session.parentID)) {
				return 'root';
			}

			return session.parentID;
		});
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
					formatModelsDisplayMultiline(parentSession.modelsUsed.map(applyModelAliasForDisplay)),
					parentSession,
					{ compact, showPercent: includePercent },
				),
			);

			await pushBreakdownRowsForSession(parentSession.sessionID, '  ▸ ');

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
							formatModelsDisplayMultiline(subSession.modelsUsed.map(applyModelAliasForDisplay)),
							subSession,
							{ compact, showPercent: includePercent },
						),
					);

					await pushBreakdownRowsForSession(subSession.sessionID, '    - ');
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
						{ yellow: true, compact, showPercent: includePercent },
					),
				);
			}
		}

		table.push(
			buildAggregateSummaryRow('Total', '', totals, {
				yellow: true,
				compact,
				showPercent: includePercent,
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
