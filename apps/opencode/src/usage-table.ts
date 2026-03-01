/**
 * Usage report table builder using cli-table3 directly.
 *
 * Provides a two-row header with "Input Breakdown" colspan spanning
 * Base, Cache Create, and Cache Read sub-columns.  Anthropic rows use
 * three cells; OpenAI rows merge Base + Cache Create via colSpan: 2.
 */
import type { CellOptions, TableConstructorOptions } from 'cli-table3';
import type { ComponentCosts, ModelTokenData, TierBreakdown } from './cost-utils.ts';
import process from 'node:process';
import { formatNumber } from '@ccusage/terminal/table';

import Table from 'cli-table3';
import pc from 'picocolors';

// ---------------------------------------------------------------------------
// Tier display helpers  (moved from cost-utils; used by cell formatters)
// ---------------------------------------------------------------------------

import { formatInputColumn, totalInputTokens } from './cost-utils.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Cell = string | CellOptions;
type Row = Cell[];

type ValueDisplayOptions = {
	showPercent?: boolean;
	hideZeroDetail?: boolean;
	showReasoningPercent?: boolean;
};

export type AggregateColumnCosts = {
	inputCost: number;
	outputCost: number;
	baseInputCost: number;
	cacheCreateCost: number;
	cacheReadCost: number;
};

export type UsageTableConfig = {
	/** Label for the first column: "Date", "Week", "Month", "Session", "Model" */
	firstColumnName: string;
	/** Whether to include a "Models" column (false for model.ts which IS per-model) */
	hasModelsColumn?: boolean;
	/** Whether percentage columns/details are enabled */
	showPercent?: boolean;
	/** Split value/detail into subcolumns for aggregate-only views */
	splitValueDetailColumns?: boolean;
	/** Per-metric percent subcolumn visibility for split views */
	splitPercentColumns?: {
		output?: boolean;
		cacheCreate?: boolean;
		cacheRead?: boolean;
	};
	/** Force compact mode (hide breakdown columns) */
	forceCompact?: boolean;
};

function tierTotalTokens(t: TierBreakdown): number {
	return t.baseTierTokens + t.aboveTierTokens;
}

function tierTotalCost(t: TierBreakdown): number {
	return t.baseTierCost + t.aboveTierCost;
}

function formatListRate(value: number): string {
	if (Number.isInteger(value)) {
		return String(value);
	}
	return value
		.toFixed(2)
		.replace(/\.00$/, '')
		.replace(/(\.\d)0$/, '$1');
}

function formatCurrencyValue(value: number): string {
	return `$${value.toFixed(2)}`;
}

function isRoundedZeroCurrency(value: number): boolean {
	return Number(value.toFixed(2)) <= 0;
}

function formatSingleTierCost(
	ratePerMillion: number | null,
	cost: number,
	options: ValueDisplayOptions,
): string | null {
	if (options.hideZeroDetail === true && isRoundedZeroCurrency(cost)) {
		return null;
	}

	if (ratePerMillion == null) {
		return pc.green(formatCurrencyValue(cost));
	}
	return `$${formatListRate(ratePerMillion)}/M→${pc.green(formatCurrencyValue(cost))}`;
}

function roundedPercent(numerator: number, denominator: number): number {
	if (denominator <= 0) {
		return 0;
	}

	return Math.round((numerator / denominator) * 100);
}

function formatPercent(numerator: number, denominator: number): string {
	const pct = roundedPercent(numerator, denominator);
	return pc.magenta(`${pct}%`);
}

function formatPlainPercent(numerator: number, denominator: number): string {
	const pct = roundedPercent(numerator, denominator);
	return `${pct}%`;
}

function maybePercent(
	numerator: number,
	denominator: number,
	options: ValueDisplayOptions,
): string | undefined {
	if (options.showPercent !== true) {
		return undefined;
	}

	if (options.hideZeroDetail === true && (numerator <= 0 || denominator <= 0)) {
		return undefined;
	}

	if (options.hideZeroDetail === true && roundedPercent(numerator, denominator) === 0) {
		return undefined;
	}

	return formatPercent(numerator, denominator);
}

function maybePlainPercent(
	numerator: number,
	denominator: number,
	options: ValueDisplayOptions,
): string | undefined {
	if (options.showPercent !== true) {
		return undefined;
	}

	if (options.hideZeroDetail === true && (numerator <= 0 || denominator <= 0)) {
		return undefined;
	}

	if (options.hideZeroDetail === true && roundedPercent(numerator, denominator) === 0) {
		return undefined;
	}

	return formatPlainPercent(numerator, denominator);
}

/**
 * Format a TierBreakdown as token line + cost line.
 * Token line includes percentage if provided.
 */
function formatTierCell(
	tier: TierBreakdown,
	pctStr?: string,
	options: ValueDisplayOptions = {},
): { tokenLine: string; costLine: string | null } {
	const total = tierTotalTokens(tier);
	const cost = tierTotalCost(tier);

	const pctSuffix = pctStr != null ? ` ${pctStr}` : '';

	if (total <= 0) {
		if (options.hideZeroDetail === true) {
			return { tokenLine: '', costLine: null };
		}

		return { tokenLine: `${formatNumber(0)}${pctSuffix}`, costLine: null };
	}

	// Token line: split when there are above-tier tokens
	const tokenLine =
		tier.aboveTierTokens > 0
			? `${formatNumber(tier.baseTierTokens)} + ${formatNumber(tier.aboveTierTokens)}${pctSuffix}`
			: `${formatNumber(total)}${pctSuffix}`;

	if (tier.aboveTierTokens <= 0) {
		const costLine = formatSingleTierCost(tier.baseTierRate, cost, options);
		return {
			tokenLine,
			costLine,
		};
	}

	const basePart = formatSingleTierCost(tier.baseTierRate, tier.baseTierCost, options);
	const abovePart = formatSingleTierCost(tier.aboveTierRate, tier.aboveTierCost, options);
	const costParts = [basePart, abovePart].filter((part): part is string => part != null);
	return {
		tokenLine,
		costLine: costParts.length > 0 ? costParts.join(' ') : null,
	};
}

// ---------------------------------------------------------------------------
// Breakdown cell formatters
// ---------------------------------------------------------------------------

/** Format a single breakdown cell (Base, Cache Create, or Cache Read). */
function formatBreakdownCell(
	tokens: number,
	tier: TierBreakdown | undefined,
	pctStr: string | undefined,
	options: ValueDisplayOptions,
): string {
	if (options.hideZeroDetail === true && tokens <= 0) {
		return '';
	}

	const pctSuffix = pctStr == null ? '' : ` ${pctStr}`;

	if (tier == null) {
		return `${formatNumber(tokens)}${pctSuffix}`;
	}

	const { tokenLine, costLine } = formatTierCell(tier, pctStr, options);
	if (costLine == null) {
		return tokenLine;
	}
	return `${tokenLine}\n${costLine}`;
}

// ---------------------------------------------------------------------------
// Output column cell formatters
// ---------------------------------------------------------------------------

function appendReasoningPercent(content: string, reasoningPct: string | undefined): string {
	if (reasoningPct == null || content === '') {
		return content;
	}

	if (content.includes('\n')) {
		const [firstLine, ...rest] = content.split('\n');
		return [`${firstLine} r=${reasoningPct}`, ...rest].join('\n');
	}

	return `${content} r=${reasoningPct}`;
}

/** Build a single output cell for a per-model row. */
export function buildOutputCells(
	data: ModelTokenData,
	componentCosts?: ComponentCosts,
	options: ValueDisplayOptions = {},
): Cell[] {
	const totalOutput = data.outputTokens + data.reasoningTokens;
	const showPercent = options.showPercent ?? true;

	// Format the main output cell (total output tokens + cost)
	let outputContent: string;
	if (componentCosts != null && totalOutput > 0) {
		const { tokenLine, costLine } = formatTierCell(componentCosts.output, undefined, options);
		outputContent = costLine != null ? `${tokenLine}\n${costLine}` : tokenLine;
	} else if (options.hideZeroDetail === true && totalOutput <= 0) {
		outputContent = '';
	} else {
		outputContent = formatNumber(totalOutput);
	}

	const reasoningPct = maybePlainPercent(data.reasoningTokens, totalOutput, {
		showPercent,
		hideZeroDetail: options.hideZeroDetail,
	});
	const contentWithReasoning = appendReasoningPercent(outputContent, reasoningPct);

	return [{ content: contentWithReasoning, hAlign: 'right' as const }];
}

/**
 * Build a single output cell for an aggregate (mixed-model) row.
 * No cost rates — just token counts.
 */
export function buildAggregateOutputCells(
	outputTokens: number,
	reasoningTokens: number,
	outputCost?: number,
	options: ValueDisplayOptions = {},
): Cell[] {
	const totalOutput = outputTokens + reasoningTokens;
	const showPercent = options.showPercent ?? true;
	const showReasoningPercent = options.showReasoningPercent ?? true;
	const reasoningPct =
		showReasoningPercent === true
			? maybePlainPercent(reasoningTokens, totalOutput, {
					showPercent,
					hideZeroDetail: options.hideZeroDetail,
				})
			: undefined;
	const pctStr = reasoningPct != null ? `r=${reasoningPct}` : undefined;
	const outputContent = formatAggregateCellWithCost(totalOutput, pctStr, outputCost, options);

	return [{ content: outputContent, hAlign: 'right' as const }];
}

function formatAggregateCellWithCost(
	tokens: number,
	pctStr: string | undefined,
	cost: number | undefined,
	options: ValueDisplayOptions,
): string {
	if (
		options.hideZeroDetail === true &&
		tokens <= 0 &&
		(cost == null || isRoundedZeroCurrency(cost))
	) {
		return '';
	}

	const tokenPart = pctStr == null ? formatNumber(tokens) : `${formatNumber(tokens)} ${pctStr}`;
	if (cost == null) {
		return tokenPart;
	}

	if (options.hideZeroDetail === true && isRoundedZeroCurrency(cost)) {
		return tokenPart;
	}

	return `${tokenPart} ${pc.green(formatCurrencyValue(cost))}`;
}

function formatAggregateTokenWithCost(
	tokens: number,
	cost: number | undefined,
	options: ValueDisplayOptions,
): string {
	if (
		options.hideZeroDetail === true &&
		tokens <= 0 &&
		(cost == null || isRoundedZeroCurrency(cost))
	) {
		return '';
	}

	const tokenPart = formatNumber(tokens);
	if (cost == null) {
		return tokenPart;
	}

	if (options.hideZeroDetail === true && isRoundedZeroCurrency(cost)) {
		return tokenPart;
	}

	return `${tokenPart} ${pc.green(formatCurrencyValue(cost))}`;
}

function buildSplitValueCostCells(
	tokens: number,
	cost: number | undefined,
	options: ValueDisplayOptions,
): Cell[] {
	const value = options.hideZeroDetail === true && tokens <= 0 ? '' : formatNumber(tokens);
	const costCell =
		cost == null || (options.hideZeroDetail === true && isRoundedZeroCurrency(cost))
			? ''
			: pc.green(formatCurrencyValue(cost));

	return [
		{ content: value, hAlign: 'right' as const },
		{ content: costCell, hAlign: 'right' as const },
	];
}

function buildSplitValuePercentCostCells(
	tokens: number,
	pctStr: string | undefined,
	cost: number | undefined,
	showPercentColumn: boolean,
	options: ValueDisplayOptions,
): Cell[] {
	const value = options.hideZeroDetail === true && tokens <= 0 ? '' : formatNumber(tokens);
	const percentCell = pctStr ?? '';
	const costCell =
		cost == null || (options.hideZeroDetail === true && isRoundedZeroCurrency(cost))
			? ''
			: pc.green(formatCurrencyValue(cost));

	if (!showPercentColumn) {
		return [
			{ content: value, hAlign: 'right' as const },
			{ content: costCell, hAlign: 'right' as const },
		];
	}

	return [
		{ content: value, hAlign: 'right' as const },
		{ content: percentCell, hAlign: 'right' as const },
		{ content: costCell, hAlign: 'right' as const },
	];
}

// ---------------------------------------------------------------------------
// Input breakdown cell formatters
// ---------------------------------------------------------------------------

/**
 * Build the 3 breakdown cells for a per-model row.
 *
 * Returns an array of either 3 cells (Anthropic: base, cache create, cache read)
 * or 2 cells where the first has colSpan: 2 (OpenAI: no cache create distinction).
 */
export function buildBreakdownCells(
	data: ModelTokenData,
	componentCosts?: ComponentCosts,
	options: ValueDisplayOptions = {},
): Cell[] {
	const total = totalInputTokens(data);
	const hasCacheCreate = data.cacheCreationTokens > 0;

	const basePct = maybePercent(data.inputTokens, total, options);
	const ccPct = maybePercent(data.cacheCreationTokens, total, options);
	const crPct = maybePercent(data.cacheReadTokens, total, options);

	if (!hasCacheCreate) {
		// OpenAI-style: merge base + cache create into one colSpan: 2 cell
		const uncachedTokens = data.inputTokens + data.cacheCreationTokens;
		const uncachedPct = maybePercent(uncachedTokens, total, options);
		const content = formatBreakdownCell(
			uncachedTokens,
			componentCosts != null
				? {
						// Merge baseInput + cacheCreate tiers (cacheCreate should be zero)
						baseTierTokens:
							componentCosts.baseInput.baseTierTokens + componentCosts.cacheCreate.baseTierTokens,
						baseTierCost:
							componentCosts.baseInput.baseTierCost + componentCosts.cacheCreate.baseTierCost,
						baseTierRate: componentCosts.baseInput.baseTierRate,
						aboveTierTokens:
							componentCosts.baseInput.aboveTierTokens + componentCosts.cacheCreate.aboveTierTokens,
						aboveTierCost:
							componentCosts.baseInput.aboveTierCost + componentCosts.cacheCreate.aboveTierCost,
						aboveTierRate: componentCosts.baseInput.aboveTierRate,
					}
				: undefined,
			uncachedPct,
			options,
		);

		const crContent = formatBreakdownCell(
			data.cacheReadTokens,
			componentCosts?.cacheRead,
			crPct,
			options,
		);

		return [
			{ content, colSpan: 2, hAlign: 'right' as const },
			{ content: crContent, hAlign: 'right' as const },
		];
	}

	// Anthropic-style: three separate cells
	const baseContent = formatBreakdownCell(
		data.inputTokens,
		componentCosts?.baseInput,
		basePct,
		options,
	);
	const ccContent = formatBreakdownCell(
		data.cacheCreationTokens,
		componentCosts?.cacheCreate,
		ccPct,
		options,
	);
	const crContent = formatBreakdownCell(
		data.cacheReadTokens,
		componentCosts?.cacheRead,
		crPct,
		options,
	);

	return [
		{ content: baseContent, hAlign: 'right' as const },
		{ content: ccContent, hAlign: 'right' as const },
		{ content: crContent, hAlign: 'right' as const },
	];
}

/**
 * Build breakdown cells for an aggregate (mixed-model) row.
 * No cost rates — just token counts with percentages on the token line.
 */
export function buildAggregateBreakdownCells(
	inputTokens: number,
	cacheCreationTokens: number,
	cacheReadTokens: number,
	costs?: Pick<AggregateColumnCosts, 'baseInputCost' | 'cacheCreateCost' | 'cacheReadCost'>,
	options: ValueDisplayOptions = {},
): Cell[] {
	const total = inputTokens + cacheCreationTokens + cacheReadTokens;
	const hasCacheCreate = cacheCreationTokens > 0;

	if (!hasCacheCreate) {
		const uncachedTokens = inputTokens + cacheCreationTokens;
		const uncachedPct = maybePercent(uncachedTokens, total, options);
		const crPct = maybePercent(cacheReadTokens, total, options);
		const uncachedCost = (costs?.baseInputCost ?? 0) + (costs?.cacheCreateCost ?? 0);

		return [
			{
				content: formatAggregateCellWithCost(uncachedTokens, uncachedPct, uncachedCost, options),
				colSpan: 2,
				hAlign: 'right' as const,
			},
			{
				content: formatAggregateCellWithCost(cacheReadTokens, crPct, costs?.cacheReadCost, options),
				hAlign: 'right' as const,
			},
		];
	}

	const basePct = maybePercent(inputTokens, total, options);
	const ccPct = maybePercent(cacheCreationTokens, total, options);
	const crPct = maybePercent(cacheReadTokens, total, options);

	return [
		{
			content: formatAggregateCellWithCost(inputTokens, basePct, costs?.baseInputCost, options),
			hAlign: 'right' as const,
		},
		{
			content: formatAggregateCellWithCost(
				cacheCreationTokens,
				ccPct,
				costs?.cacheCreateCost,
				options,
			),
			hAlign: 'right' as const,
		},
		{
			content: formatAggregateCellWithCost(cacheReadTokens, crPct, costs?.cacheReadCost, options),
			hAlign: 'right' as const,
		},
	];
}

/**
 * Remap entry-level token counts for aggregate accumulation.
 *
 * OpenAI reports all non-cached input as `inputTokens` with
 * `cacheCreationInputTokens === 0`.  Semantically these tokens are
 * equivalent to Anthropic's cache-creation bucket, so for aggregate
 * totals we shift them from Base → Cache Create to keep the totals
 * meaningful across providers.
 */
export function remapTokensForAggregate(entry: {
	inputTokens: number;
	cacheCreationInputTokens: number;
	cacheReadInputTokens: number;
}): { base: number; cacheCreate: number; cacheRead: number } {
	if (entry.cacheCreationInputTokens > 0) {
		// Anthropic-style: keep as-is
		return {
			base: entry.inputTokens,
			cacheCreate: entry.cacheCreationInputTokens,
			cacheRead: entry.cacheReadInputTokens,
		};
	}
	// OpenAI-style: shift uncached input into cache-create bucket
	return {
		base: 0,
		cacheCreate: entry.inputTokens,
		cacheRead: entry.cacheReadInputTokens,
	};
}

// ---------------------------------------------------------------------------
// Table builder
// ---------------------------------------------------------------------------

/**
 * Create a cli-table3 instance with the two-row header
 * (top row uses colSpan for "Input Breakdown").
 */
export function createUsageTable(config: UsageTableConfig): Table.Table {
	const hasModels = config.hasModelsColumn ?? true;
	const showPercent = config.showPercent ?? false;
	const splitValueDetailColumns = config.splitValueDetailColumns ?? false;
	const splitPercentColumns = {
		output: config.splitPercentColumns?.output ?? showPercent,
		cacheCreate: config.splitPercentColumns?.cacheCreate ?? showPercent,
		cacheRead: config.splitPercentColumns?.cacheRead ?? showPercent,
	};

	const terminalWidth =
		Number.parseInt(process.env.COLUMNS ?? '', 10) || process.stdout.columns || 120;
	const isCompact = config.forceCompact === true || terminalWidth < 90;

	// In compact mode, drop the 3 breakdown columns entirely
	if (isCompact) {
		const compactOpts: TableConstructorOptions = {
			style: { head: ['cyan'] },
			colAligns: hasModels
				? ['left', 'left', 'right', 'right', 'right']
				: ['left', 'right', 'right', 'right'],
			head: hasModels
				? [config.firstColumnName, 'Models', 'Input', 'Output', 'Cost (USD)']
				: [config.firstColumnName, 'Input', 'Output', 'Cost (USD)'],
		};
		return new Table(compactOpts);
	}

	// Full mode: no predefined head — we push the header rows manually
	const opts: TableConstructorOptions = {
		style: { head: ['cyan'] },
	};
	const table = new Table(opts);

	// --- Row 1: top header with Input Breakdown colspan ---
	const headerRow1: Cell[] = [
		{ content: pc.cyan(config.firstColumnName), rowSpan: 2, vAlign: 'center' },
	];
	if (hasModels) {
		headerRow1.push({ content: pc.cyan('Models'), rowSpan: 2, vAlign: 'center' });
	}
	if (splitValueDetailColumns) {
		const outputColSpan = 2 + (splitPercentColumns.output ? 1 : 0);
		const baseColSpan = 2;
		const cacheCreateColSpan = 2 + (splitPercentColumns.cacheCreate ? 1 : 0);
		const cacheReadColSpan = 2 + (splitPercentColumns.cacheRead ? 1 : 0);
		headerRow1.push({
			content: pc.cyan('Input'),
			colSpan: 2,
			rowSpan: 2,
			vAlign: 'center',
			hAlign: 'center',
		});
		headerRow1.push({
			content: pc.cyan(showPercent ? 'Output/Reasoning%' : 'Output'),
			colSpan: outputColSpan,
			rowSpan: 2,
			vAlign: 'center',
			hAlign: 'center',
		});
		headerRow1.push(
			{
				content: pc.cyan('Input Breakdown'),
				colSpan: baseColSpan + cacheCreateColSpan + cacheReadColSpan,
				hAlign: 'center',
			},
			{ content: pc.cyan('Cost (USD)'), rowSpan: 2, vAlign: 'center', hAlign: 'right' },
		);
	} else {
		headerRow1.push({ content: pc.cyan('Input'), rowSpan: 2, vAlign: 'center', hAlign: 'right' });
		headerRow1.push({
			content: pc.cyan(showPercent ? 'Output/Reasoning%' : 'Output'),
			rowSpan: 2,
			vAlign: 'center',
			hAlign: 'right',
		});
		headerRow1.push(
			{ content: pc.cyan('Input Breakdown'), colSpan: 3, hAlign: 'center' },
			{ content: pc.cyan('Cost (USD)'), rowSpan: 2, vAlign: 'center', hAlign: 'right' },
		);
	}
	table.push(headerRow1);

	// --- Row 2: sub-headers for Input Breakdown columns ---
	if (splitValueDetailColumns) {
		table.push([
			{ content: pc.cyan('Base'), colSpan: 2, hAlign: 'center' },
			{
				content: pc.cyan('Cache Create'),
				colSpan: 2 + (splitPercentColumns.cacheCreate ? 1 : 0),
				hAlign: 'center',
			},
			{
				content: pc.cyan('Cache Read'),
				colSpan: 2 + (splitPercentColumns.cacheRead ? 1 : 0),
				hAlign: 'center',
			},
		]);
	} else {
		table.push([
			{ content: pc.cyan('Base'), hAlign: 'right' },
			{ content: pc.cyan('Cache Create'), hAlign: 'right' },
			{ content: pc.cyan('Cache Read'), hAlign: 'right' },
		]);
	}

	return table;
}

/**
 * Check if a table was created in compact mode (has `head` option set).
 * Compact tables use the standard head option; full tables have manual header rows.
 */
export function isCompactTable(table: Table.Table): boolean {
	// Compact tables have the head option populated in options
	return (table as unknown as { options: { head: string[] } }).options.head.length > 0;
}

// ---------------------------------------------------------------------------
// Row builder helpers
// ---------------------------------------------------------------------------

/**
 * Build a per-model breakdown row (with cost rates).
 * Used in --full mode under each time period / session.
 */
export function buildModelBreakdownRow(
	firstCell: string,
	modelsCell: string | null,
	data: ModelTokenData,
	componentCosts: ComponentCosts | undefined,
	options: ValueDisplayOptions = {},
): Row {
	const outputCells = buildOutputCells(data, componentCosts, options);
	const breakdownCells = buildBreakdownCells(data, componentCosts, options);
	const row: Cell[] = [firstCell];
	if (modelsCell != null) {
		row.push(modelsCell);
	}
	row.push(
		{
			content: formatInputColumn(data, componentCosts, {
				hideZeroDetail: options.hideZeroDetail,
			}),
			hAlign: 'right' as const,
		},
		...outputCells,
		...breakdownCells,
		{ content: pc.green(`$${data.totalCost.toFixed(2)}`), hAlign: 'right' as const },
	);
	return row;
}

/**
 * Build an aggregate summary row (no cost rates, mixed models).
 */
export function buildAggregateSummaryRow(
	firstCell: string,
	modelsCell: string | null,
	data: {
		inputTokens: number;
		outputTokens: number;
		reasoningTokens: number;
		cacheCreationTokens: number;
		cacheReadTokens: number;
		totalCost: number;
	},
	options?: {
		bold?: boolean;
		yellow?: boolean;
		compact?: boolean;
		columnCosts?: AggregateColumnCosts;
		showPercent?: boolean;
		hideZeroDetail?: boolean;
		showReasoningPercent?: boolean;
		splitValueDetailColumns?: boolean;
		splitPercentColumns?: {
			output?: boolean;
			cacheCreate?: boolean;
			cacheRead?: boolean;
		};
	},
): Row {
	const wrap = (s: string): string => {
		let result = s;
		if (options?.bold === true) {
			result = pc.bold(result);
		}
		if (options?.yellow === true) {
			result = pc.yellow(result);
		}
		return result;
	};

	const totalInput = data.inputTokens + data.cacheCreationTokens + data.cacheReadTokens;
	const totalOutput = data.outputTokens + data.reasoningTokens;
	const splitValueDetailColumns = options?.splitValueDetailColumns ?? false;
	const splitPercentColumns = {
		output: options?.splitPercentColumns?.output ?? options?.showPercent ?? false,
		cacheCreate: options?.splitPercentColumns?.cacheCreate ?? options?.showPercent ?? false,
		cacheRead: options?.splitPercentColumns?.cacheRead ?? options?.showPercent ?? false,
	};
	const isTotalsRow = firstCell === 'Total' || modelsCell?.endsWith(' Total') === true;
	const showReasoningPercent = options?.showReasoningPercent ?? !isTotalsRow;

	const costStr =
		options?.yellow === true
			? pc.yellow(pc.green(`$${data.totalCost.toFixed(2)}`))
			: pc.green(`$${data.totalCost.toFixed(2)}`);

	const row: Cell[] = [wrap(firstCell)];
	if (modelsCell != null) {
		row.push(wrap(modelsCell));
	}

	const wrapCells = (cells: Cell[]): Cell[] =>
		cells.map((cell) => {
			if (typeof cell === 'object' && 'content' in cell) {
				return { ...cell, content: wrap(String(cell.content)) };
			}
			return wrap(String(cell));
		});

	if (options?.compact === true) {
		// Compact: single output string, no breakdown columns
		const inputContent = formatAggregateTokenWithCost(totalInput, options?.columnCosts?.inputCost, {
			hideZeroDetail: options?.hideZeroDetail,
		});
		const reasoningPct =
			showReasoningPercent === true
				? maybePlainPercent(data.reasoningTokens, totalOutput, {
						showPercent: options?.showPercent,
						hideZeroDetail: options?.hideZeroDetail,
					})
				: undefined;
		const pctStr = reasoningPct != null ? `r=${reasoningPct}` : undefined;
		const outputContent = formatAggregateCellWithCost(
			totalOutput,
			pctStr,
			options?.columnCosts?.outputCost,
			{ hideZeroDetail: options?.hideZeroDetail },
		);
		row.push(
			{ content: wrap(inputContent), hAlign: 'right' as const },
			{ content: wrap(outputContent), hAlign: 'right' as const },
			{ content: costStr, hAlign: 'right' as const },
		);
		return row;
	}

	if (splitValueDetailColumns) {
		const displayOptions: ValueDisplayOptions = {
			showPercent: options?.showPercent,
			hideZeroDetail: options?.hideZeroDetail,
		};
		const reasoningPct =
			showReasoningPercent === true
				? maybePlainPercent(data.reasoningTokens, totalOutput, displayOptions)
				: undefined;
		const outputPct = reasoningPct != null ? `r=${reasoningPct}` : undefined;
		const inputCells = buildSplitValueCostCells(
			totalInput,
			options?.columnCosts?.inputCost,
			displayOptions,
		);
		const outputCells = buildSplitValuePercentCostCells(
			totalOutput,
			outputPct,
			options?.columnCosts?.outputCost,
			splitPercentColumns.output,
			displayOptions,
		);

		let breakdownCells: Cell[];
		if (data.cacheCreationTokens > 0) {
			const ccPct = maybePercent(data.cacheCreationTokens, totalInput, displayOptions);
			const crPct = maybePercent(data.cacheReadTokens, totalInput, displayOptions);
			breakdownCells = [
				...buildSplitValueCostCells(
					data.inputTokens,
					options?.columnCosts?.baseInputCost,
					displayOptions,
				),
				...buildSplitValuePercentCostCells(
					data.cacheCreationTokens,
					ccPct,
					options?.columnCosts?.cacheCreateCost,
					splitPercentColumns.cacheCreate,
					displayOptions,
				),
				...buildSplitValuePercentCostCells(
					data.cacheReadTokens,
					crPct,
					options?.columnCosts?.cacheReadCost,
					splitPercentColumns.cacheRead,
					displayOptions,
				),
			];
		} else {
			const uncachedTokens = data.inputTokens + data.cacheCreationTokens;
			const uncachedPct = maybePercent(uncachedTokens, totalInput, displayOptions);
			const uncachedCost =
				(options?.columnCosts?.baseInputCost ?? 0) + (options?.columnCosts?.cacheCreateCost ?? 0);
			const baseCells = buildSplitValueCostCells(0, undefined, displayOptions);
			const uncachedCells = buildSplitValuePercentCostCells(
				uncachedTokens,
				uncachedPct,
				uncachedCost,
				splitPercentColumns.cacheCreate,
				displayOptions,
			);
			const crPct = maybePercent(data.cacheReadTokens, totalInput, displayOptions);
			breakdownCells = [
				...baseCells,
				...uncachedCells,
				...buildSplitValuePercentCostCells(
					data.cacheReadTokens,
					crPct,
					options?.columnCosts?.cacheReadCost,
					splitPercentColumns.cacheRead,
					displayOptions,
				),
			];
		}

		const splitCells = [...inputCells, ...outputCells, ...breakdownCells];
		row.push(...wrapCells(splitCells), { content: costStr, hAlign: 'right' as const });
		return row;
	}

	const outputCells = buildAggregateOutputCells(
		data.outputTokens,
		data.reasoningTokens,
		options?.columnCosts?.outputCost,
		{
			showPercent: options?.showPercent,
			hideZeroDetail: options?.hideZeroDetail,
			showReasoningPercent,
		},
	);
	const breakdownCells = buildAggregateBreakdownCells(
		data.inputTokens,
		data.cacheCreationTokens,
		data.cacheReadTokens,
		options?.columnCosts == null
			? undefined
			: {
					baseInputCost: options.columnCosts.baseInputCost,
					cacheCreateCost: options.columnCosts.cacheCreateCost,
					cacheReadCost: options.columnCosts.cacheReadCost,
				},
		{ showPercent: options?.showPercent, hideZeroDetail: options?.hideZeroDetail },
	);

	row.push(
		{
			content: wrap(
				formatAggregateTokenWithCost(totalInput, options?.columnCosts?.inputCost, {
					hideZeroDetail: options?.hideZeroDetail,
				}),
			),
			hAlign: 'right' as const,
		},
		...wrapCells(outputCells),
		...wrapCells(breakdownCells),
		{ content: costStr, hAlign: 'right' as const },
	);
	return row;
}

/**
 * Build a compact-mode row (no breakdown columns).
 */
export function buildCompactRow(
	firstCell: string,
	modelsCell: string | null,
	inputStr: string,
	outputStr: string,
	costStr: string,
): Row {
	const row: Cell[] = [firstCell];
	if (modelsCell != null) {
		row.push(modelsCell);
	}
	row.push(inputStr, outputStr, costStr);
	return row;
}
