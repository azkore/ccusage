import type { ComponentCosts, ModelTokenData } from '../cost-utils.ts';
import type { LoadedUsageEntry } from '../data-loader.ts';
import { LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import { groupBy } from 'es-toolkit';
import { define } from 'gunshi';
import pc from 'picocolors';
import {
	formatReportSourceLabel,
	isDisplayedZeroCost,
	resolveBreakdownDimensions,
} from '../breakdown.ts';
import {
	calculateComponentCostsFromEntries,
	calculateCostForEntry,
	totalInputTokens,
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
import { createModelLabelResolver, formatModelLabelForTable } from '../model-display.ts';
import {
	buildAggregateSummaryRow,
	buildModelBreakdownRow,
	createUsageTable,
	isCompactTable,
	remapTokensForAggregate,
} from '../usage-table.ts';

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
	description:
		'Show OpenCode token usage grouped by model. Per-model rate details ($/M→$...) are shown by default; use --breakdown for extra grouping.',
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
				"Choose breakdown dimensions (comma-separated): source, provider, full-model, cost, percent, project, session. Use 'none' to disable.",
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
		const breakdowns = resolveBreakdownDimensions({
			full: ctx.values.full === true,
			breakdownInput,
			available: ['source', 'provider', 'full-model', 'cost', 'percent', 'project', 'session'],
		});
		const groupingBreakdowns = breakdowns.filter(
			(dimension) => dimension !== 'cost' && dimension !== 'percent',
		);
		const showBreakdown = groupingBreakdowns.length > 0;
		const includeSource = breakdowns.includes('source');
		const includeProvider = breakdowns.includes('provider');
		const includeFullModel = breakdowns.includes('full-model');
		const includeCost = breakdowns.includes('cost');
		const includePercent = breakdowns.includes('percent');
		const includeProject = breakdowns.includes('project');
		const includeSession = breakdowns.includes('session');
		const showProjectBreakdown = includeProject || includeSession;
		const showSessionBreakdown = includeSession;
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
				? JSON.stringify({ source, models: [], totals: null })
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
		const entriesByModel = groupBy(filteredEntries, (entry) => modelLabelForEntry(entry));

		const modelData: Array<
			ModelTokenData & {
				model: string;
				componentCosts: ComponentCosts;
				entries: LoadedUsageEntry[];
				projectBreakdown: ProjectBreakdown[];
			}
		> = [];
		const entryCostMap = new Map<LoadedUsageEntry, number>();

		for (const [modelLabel, modelEntries] of Object.entries(entriesByModel)) {
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
				entryCostMap.set(entry, cost);
				const mapped = remapTokensForAggregate(entry.usage);
				inputTokens += mapped.base;
				outputTokens += entry.usage.outputTokens;
				reasoningTokens += entry.usage.reasoningTokens;
				cacheCreationTokens += mapped.cacheCreate;
				cacheReadTokens += mapped.cacheRead;
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

			const pricingModel = modelEntries[0]?.model ?? modelLabel;
			const componentCosts = await calculateComponentCostsFromEntries(
				modelEntries,
				pricingModel,
				fetcher,
			);
			const projectBreakdown = Array.from(projectBreakdownMap.entries())
				.map(([projectName, data]) => ({
					projectName,
					...data.metrics,
					entries: data.entries,
					sessions: Array.from(data.sessions.values()).sort(
						(a, b) => b.totalCost - a.totalCost || a.sessionTitle.localeCompare(b.sessionTitle),
					),
				}))
				.sort((a, b) => b.totalCost - a.totalCost || a.projectName.localeCompare(b.projectName));

			modelData.push({
				model: modelLabel,
				inputTokens,
				outputTokens,
				reasoningTokens,
				cacheCreationTokens,
				cacheReadTokens,
				totalCost,
				componentCosts,
				entries: modelEntries,
				projectBreakdown,
			});
		}

		// Sort by total cost descending
		modelData.sort((a, b) => b.totalCost - a.totalCost || a.model.localeCompare(b.model));

		const visibleModelData = skipZero
			? modelData.filter((model) => !isDisplayedZeroCost(model.totalCost))
			: modelData;

		if (visibleModelData.length === 0) {
			const output = jsonOutput
				? JSON.stringify({ source, models: [], totals: null })
				: 'No usage rows found after applying --skip-zero.';
			// eslint-disable-next-line no-console
			console.log(output);
			return;
		}

		const totals = {
			inputTokens: visibleModelData.reduce((sum, d) => sum + d.inputTokens, 0),
			outputTokens: visibleModelData.reduce((sum, d) => sum + d.outputTokens, 0),
			reasoningTokens: visibleModelData.reduce((sum, d) => sum + d.reasoningTokens, 0),
			cacheCreationTokens: visibleModelData.reduce((sum, d) => sum + d.cacheCreationTokens, 0),
			cacheReadTokens: visibleModelData.reduce((sum, d) => sum + d.cacheReadTokens, 0),
			totalCost: visibleModelData.reduce((sum, d) => sum + d.totalCost, 0),
		};
		if (jsonOutput) {
			// eslint-disable-next-line no-console
			console.log(
				JSON.stringify(
					{
						source,
						models: visibleModelData.map((d) => ({
							model: d.model,
							inputTokens: totalInputTokens(d),
							outputTokens: d.outputTokens,
							reasoningTokens: d.reasoningTokens,
							cacheReadTokens: d.cacheReadTokens,
							totalCost: d.totalCost,
							...(showProjectBreakdown
								? {
										projectBreakdown: d.projectBreakdown
											.filter(
												(projectData) => !skipZero || !isDisplayedZeroCost(projectData.totalCost),
											)
											.map((projectData) => ({
												projectName: projectData.projectName,
												inputTokens: totalInputTokens(projectData),
												outputTokens: projectData.outputTokens,
												reasoningTokens: projectData.reasoningTokens,
												cacheReadTokens: projectData.cacheReadTokens,
												totalCost: projectData.totalCost,
												...(showSessionBreakdown
													? {
															sessions: projectData.sessions
																.filter(
																	(sessionData) =>
																		!skipZero || !isDisplayedZeroCost(sessionData.totalCost),
																)
																.map((sessionData) => ({
																	sessionID: sessionData.sessionID,
																	sessionTitle: sessionData.sessionTitle,
																	inputTokens: totalInputTokens(sessionData),
																	outputTokens: sessionData.outputTokens,
																	reasoningTokens: sessionData.reasoningTokens,
																	cacheReadTokens: sessionData.cacheReadTokens,
																	totalCost: sessionData.totalCost,
																})),
														}
													: {}),
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

		const sourceLabel = formatReportSourceLabel(source);

		// eslint-disable-next-line no-console
		console.log(`\n📊 ${sourceLabel} Token Usage Report - By Model\n`);

		const table = createUsageTable({
			firstColumnName: 'Model',
			hasModelsColumn: false,
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

			for (const entry of entries) {
				inputTokens += entry.usage.inputTokens;
				outputTokens += entry.usage.outputTokens;
				reasoningTokens += entry.usage.reasoningTokens;
				cacheCreationTokens += entry.usage.cacheCreationInputTokens;
				cacheReadTokens += entry.usage.cacheReadInputTokens;
				totalCost += entryCostMap.get(entry) ?? 0;
			}

			return {
				inputTokens,
				outputTokens,
				reasoningTokens,
				cacheCreationTokens,
				cacheReadTokens,
				totalCost,
			};
		};

		if (showBreakdown && !compact) {
			const breakdownSourceEntries = visibleModelData.flatMap((data) => data.entries);
			const groupedEntries = groupBy(breakdownSourceEntries, (entry) => {
				const keyParts: string[] = [];
				const metadata = sessionMetadataMap.get(entry.sessionID);
				const projectName = extractProjectName(
					metadata?.directory ?? 'unknown',
					metadata?.projectID ?? '',
				);
				const modelKey = includeFullModel
					? createFullModelLabel(entry)
					: includeProvider
						? plainModelLabelForEntry(entry)
						: modelLabelForEntry(entry);

				if (includeSource && !includeFullModel) {
					keyParts.push(entry.source);
				}
				if (includeProvider && !includeFullModel) {
					keyParts.push(entry.provider);
				}
				if (includeProject) {
					keyParts.push(projectName);
				}
				if (includeSession) {
					keyParts.push(entry.sessionID);
				}

				keyParts.push(modelKey);
				return keyParts.join('/');
			});

			const breakdownRows = Object.entries(groupedEntries)
				.map(([label, entries]) => ({
					label,
					entries,
					totals: aggregateEntries(entries),
				}))
				.filter((row) => !skipZero || !isDisplayedZeroCost(row.totals.totalCost))
				.sort((a, b) => b.totals.totalCost - a.totals.totalCost);

			for (const row of breakdownRows) {
				if (includeCost) {
					const pricingModel = row.entries[0]?.model ?? row.label;
					const componentCosts = await calculateComponentCostsFromEntries(
						row.entries,
						pricingModel,
						fetcher,
					);

					table.push(
						buildModelBreakdownRow(
							formatModelLabelForTable(row.label),
							null,
							row.totals,
							componentCosts,
							{ showPercent: includePercent },
						),
					);
					continue;
				}

				table.push(
					buildAggregateSummaryRow(formatModelLabelForTable(row.label), null, row.totals, {
						compact,
						showPercent: includePercent,
					}),
				);
			}
		} else {
			for (const data of visibleModelData) {
				// Model summary rows use per-model costs (not aggregate)
				table.push(
					buildModelBreakdownRow(
						pc.bold(formatModelLabelForTable(data.model)),
						null,
						data,
						data.componentCosts,
						{ showPercent: includePercent },
					),
				);
			}
		}

		table.push(
			buildAggregateSummaryRow('Total', null, totals, {
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
