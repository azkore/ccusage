import type { LiteLLMModelPricing, LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import type { LoadedUsageEntry } from './data-loader.ts';
import { formatNumber } from '@ccusage/terminal/table';
import { Result } from '@praha/byethrow';
import pc from 'picocolors';

/**
 * Model aliases for OpenCode-specific model names that don't exist in LiteLLM.
 * Maps OpenCode model names to their LiteLLM equivalents for pricing lookup.
 */
const MODEL_ALIASES: Record<string, string> = {
	// OpenCode uses -high suffix for higher tier/thinking mode variants
	'gemini-3-pro-high': 'gemini-3-pro-preview',
};

const MILLION = 1_000_000;

function resolveModelName(modelName: string): string {
	return MODEL_ALIASES[modelName] ?? modelName;
}

/**
 * Calculate cost for a single usage entry
 * Uses pre-calculated cost if available, otherwise calculates from tokens
 */
export async function calculateCostForEntry(
	entry: LoadedUsageEntry,
	fetcher: LiteLLMPricingFetcher,
): Promise<number> {
	if (entry.costUSD != null && entry.costUSD > 0) {
		return entry.costUSD;
	}

	const resolvedModel = resolveModelName(entry.model);
	const result = await fetcher.calculateCostFromTokens(
		{
			input_tokens: entry.usage.inputTokens,
			output_tokens: entry.usage.outputTokens + entry.usage.reasoningTokens,
			cache_creation_input_tokens: entry.usage.cacheCreationInputTokens,
			cache_read_input_tokens: entry.usage.cacheReadInputTokens,
		},
		resolvedModel,
	);

	return Result.unwrap(result, 0);
}

/**
 * Component-level cost breakdown for a model's aggregated tokens
 */
export type ComponentCosts = {
	uncachedInputCost: number;
	outputCost: number;
	cacheReadCost: number;
	uncachedInputListRatePerMillion: string;
	cacheReadListRatePerMillion: string;
};

type ComponentRateInfo = Pick<
	ComponentCosts,
	'uncachedInputListRatePerMillion' | 'cacheReadListRatePerMillion'
>;

/**
 * Calculate per-component costs using the model's actual pricing.
 */
export async function calculateComponentCosts(
	tokens: {
		inputTokens: number;
		outputTokens: number;
		reasoningTokens: number;
		cacheCreationTokens: number;
		cacheReadTokens: number;
	},
	modelName: string,
	fetcher: LiteLLMPricingFetcher,
): Promise<ComponentCosts> {
	const resolvedModel = resolveModelName(modelName);
	const pricingResult = await fetcher.getModelPricing(resolvedModel);
	const pricing: LiteLLMModelPricing | null = Result.unwrap(pricingResult, null);

	if (pricing == null) {
		return {
			uncachedInputCost: 0,
			outputCost: 0,
			cacheReadCost: 0,
			uncachedInputListRatePerMillion: '0',
			cacheReadListRatePerMillion: '0',
		};
	}

	const rateInfo = getComponentRateInfo(pricing);

	const uncachedInputCost = fetcher.calculateCostFromPricing(
		{
			input_tokens: tokens.inputTokens,
			output_tokens: 0,
			cache_creation_input_tokens: tokens.cacheCreationTokens,
		},
		pricing,
	);

	const outputCost = fetcher.calculateCostFromPricing(
		{
			input_tokens: 0,
			output_tokens: tokens.outputTokens + tokens.reasoningTokens,
		},
		pricing,
	);

	const cacheReadCost = fetcher.calculateCostFromPricing(
		{
			input_tokens: 0,
			output_tokens: 0,
			cache_read_input_tokens: tokens.cacheReadTokens,
		},
		pricing,
	);

	return {
		uncachedInputCost,
		outputCost,
		cacheReadCost,
		...rateInfo,
	};
}

/**
 * Calculate per-component costs by summing per-entry component costs.
 * This preserves per-request tier behavior and then scales each entry's
 * component split to match authoritative entry.costUSD when available.
 */
export async function calculateComponentCostsFromEntries(
	entries: LoadedUsageEntry[],
	modelName: string,
	fetcher: LiteLLMPricingFetcher,
): Promise<ComponentCosts> {
	const resolvedModel = resolveModelName(modelName);
	const pricingResult = await fetcher.getModelPricing(resolvedModel);
	const pricing: LiteLLMModelPricing | null = Result.unwrap(pricingResult, null);

	if (pricing == null) {
		return {
			uncachedInputCost: 0,
			outputCost: 0,
			cacheReadCost: 0,
			uncachedInputListRatePerMillion: '0',
			cacheReadListRatePerMillion: '0',
		};
	}

	const rateInfo = getComponentRateInfo(pricing);

	let uncachedInputCost = 0;
	let outputCost = 0;
	let cacheReadCost = 0;

	for (const entry of entries) {
		const entryUncachedCost = fetcher.calculateCostFromPricing(
			{
				input_tokens: entry.usage.inputTokens,
				output_tokens: 0,
				cache_creation_input_tokens: entry.usage.cacheCreationInputTokens,
			},
			pricing,
		);
		const entryOutputCost = fetcher.calculateCostFromPricing(
			{
				input_tokens: 0,
				output_tokens: entry.usage.outputTokens + entry.usage.reasoningTokens,
			},
			pricing,
		);
		const entryCacheReadCost = fetcher.calculateCostFromPricing(
			{
				input_tokens: 0,
				output_tokens: 0,
				cache_read_input_tokens: entry.usage.cacheReadInputTokens,
			},
			pricing,
		);

		const calculatedTotal = entryUncachedCost + entryOutputCost + entryCacheReadCost;
		const authoritativeTotal = entry.costUSD != null && entry.costUSD > 0 ? entry.costUSD : null;

		if (authoritativeTotal != null && calculatedTotal > 0) {
			const scale = authoritativeTotal / calculatedTotal;
			uncachedInputCost += entryUncachedCost * scale;
			outputCost += entryOutputCost * scale;
			cacheReadCost += entryCacheReadCost * scale;
			continue;
		}

		uncachedInputCost += entryUncachedCost;
		outputCost += entryOutputCost;
		cacheReadCost += entryCacheReadCost;
	}

	return {
		uncachedInputCost,
		outputCost,
		cacheReadCost,
		...rateInfo,
	};
}

function getComponentRateInfo(pricing: LiteLLMModelPricing): ComponentRateInfo {
	const inputBaseRate =
		pricing.input_cost_per_token != null ? pricing.input_cost_per_token * MILLION : null;
	const inputTieredRate =
		pricing.input_cost_per_token_above_200k_tokens != null
			? pricing.input_cost_per_token_above_200k_tokens * MILLION
			: null;
	const cacheCreateBaseRate =
		pricing.cache_creation_input_token_cost != null
			? pricing.cache_creation_input_token_cost * MILLION
			: null;
	const cacheCreateTieredRate =
		pricing.cache_creation_input_token_cost_above_200k_tokens != null
			? pricing.cache_creation_input_token_cost_above_200k_tokens * MILLION
			: null;
	const cacheReadBaseRate =
		pricing.cache_read_input_token_cost != null
			? pricing.cache_read_input_token_cost * MILLION
			: null;
	const cacheReadTieredRate =
		pricing.cache_read_input_token_cost_above_200k_tokens != null
			? pricing.cache_read_input_token_cost_above_200k_tokens * MILLION
			: null;

	const uncachedInputListRatePerMillion = formatRateRange(
		[inputBaseRate, inputTieredRate, cacheCreateBaseRate, cacheCreateTieredRate].filter(
			(rate): rate is number => rate != null,
		),
	);
	const cacheReadListRatePerMillion = formatRateRange(
		[cacheReadBaseRate, cacheReadTieredRate].filter((rate): rate is number => rate != null),
	);

	return {
		uncachedInputListRatePerMillion,
		cacheReadListRatePerMillion,
	};
}

function formatRateNumber(cost: number, tokens: number): string {
	if (tokens <= 0) {
		return '0';
	}
	return ((cost / tokens) * MILLION)
		.toFixed(2)
		.replace(/\.00$/, '')
		.replace(/(\.\d)0$/, '$1');
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

function formatRateRange(rates: number[]): string {
	if (rates.length === 0) {
		return '0';
	}

	const minRate = Math.min(...rates);
	const maxRate = Math.max(...rates);
	if (minRate === maxRate) {
		return formatListRate(minRate);
	}

	return `${formatListRate(minRate)}-${formatListRate(maxRate)}`;
}

function formatListedRateWithAverage(listRate: string, cost: number, tokens: number): string {
	if (!listRate.includes('-') || tokens <= 0) {
		return listRate;
	}

	const averageRate = formatRateNumber(cost, tokens);
	return `${listRate}(~${averageRate})`;
}

function formatPercent(numerator: number, denominator: number): string {
	if (denominator <= 0) {
		return pc.magenta('0%');
	}

	const pct = Math.round((numerator / denominator) * 100);
	return pc.magenta(`${pct}%`);
}

function formatCurrencyValue(value: number): string {
	return `$${value.toFixed(2)}`;
}

/**
 * Aggregated token data for a single model (used in breakdown rows)
 */
export type ModelTokenData = {
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
};

export function uncachedInputTokens(data: {
	inputTokens: number;
	cacheCreationTokens: number;
}): number {
	return data.inputTokens + data.cacheCreationTokens;
}

export function totalInputTokens(data: {
	inputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
}): number {
	return data.inputTokens + data.cacheCreationTokens + data.cacheReadTokens;
}

/** Input Uncached: value + listed rate/cost/percent (or value+percent for mixed summary). */
export function formatUncachedInputColumn(
	data: ModelTokenData,
	componentCosts?: ComponentCosts,
): string {
	const uncachedInput = uncachedInputTokens(data);
	const totalInput = totalInputTokens(data);
	const uncachedPct = formatPercent(uncachedInput, totalInput);

	if (componentCosts == null) {
		return `${formatNumber(uncachedInput)}\n${uncachedPct}`;
	}

	const listedRate = formatListedRateWithAverage(
		componentCosts.uncachedInputListRatePerMillion,
		componentCosts.uncachedInputCost,
		uncachedInput,
	);

	return `${formatNumber(uncachedInput)}\n$${listedRate}/M→${pc.green(formatCurrencyValue(componentCosts.uncachedInputCost))} ${uncachedPct}`;
}

/** Input Cached: value + listed rate/cost/percent (or value+percent for mixed summary). */
export function formatCachedInputColumn(
	data: ModelTokenData,
	componentCosts?: ComponentCosts,
): string {
	const totalInput = totalInputTokens(data);
	const cachedPct = formatPercent(data.cacheReadTokens, totalInput);

	if (componentCosts == null) {
		return `${formatNumber(data.cacheReadTokens)}\n${cachedPct}`;
	}

	const listedRate = formatListedRateWithAverage(
		componentCosts.cacheReadListRatePerMillion,
		componentCosts.cacheReadCost,
		data.cacheReadTokens,
	);

	return `${formatNumber(data.cacheReadTokens)}\n$${listedRate}/M→${pc.green(formatCurrencyValue(componentCosts.cacheReadCost))} ${cachedPct}`;
}

/** Input Total: value + real effective rate/cost. */
export function formatInputColumn(data: ModelTokenData, componentCosts?: ComponentCosts): string {
	const totalInput = totalInputTokens(data);

	if (componentCosts == null) {
		return formatNumber(totalInput);
	}

	const totalInputCost = componentCosts.uncachedInputCost + componentCosts.cacheReadCost;
	const realRate = formatRateNumber(totalInputCost, totalInput);
	return `${formatNumber(totalInput)}\n$${realRate}/M→${pc.green(formatCurrencyValue(totalInputCost))}`;
}

/** Output/Reasoning: value + real effective rate/cost. */
export function formatOutputColumn(data: ModelTokenData, componentCosts?: ComponentCosts): string {
	const outputTokenDisplay = formatOutputValueWithReasoningPct(
		data.outputTokens,
		data.reasoningTokens,
	);

	if (componentCosts == null) {
		return outputTokenDisplay;
	}

	const outputTotalTokens = data.outputTokens + data.reasoningTokens;
	if (outputTotalTokens <= 0) {
		return outputTokenDisplay;
	}

	const realRate = formatRateNumber(componentCosts.outputCost, outputTotalTokens);
	return `${outputTokenDisplay}\n$${realRate}/M→${pc.green(formatCurrencyValue(componentCosts.outputCost))}`;
}

export function formatOutputValueWithReasoningPct(
	outputTokens: number,
	reasoningTokens: number,
): string {
	if (reasoningTokens <= 0) {
		return formatNumber(outputTokens);
	}

	const reasoningPct = formatPercent(reasoningTokens, outputTokens + reasoningTokens);
	return `${formatNumber(outputTokens)} ${reasoningPct}r`;
}

/** Aggregate (mixed-model) Input Cached column: value + percent only. */
export function formatAggregateCachedInputColumn(
	inputTokens: number,
	cacheCreationTokens: number,
	cacheReadTokens: number,
): string {
	const totalInput = inputTokens + cacheCreationTokens + cacheReadTokens;
	const cachedPct = formatPercent(cacheReadTokens, totalInput);
	return `${formatNumber(cacheReadTokens)}\n${cachedPct}`;
}

/** Aggregate (mixed-model) Input Uncached column: value + percent only. */
export function formatAggregateUncachedInputColumn(
	inputTokens: number,
	cacheCreationTokens: number,
	cacheReadTokens: number,
): string {
	const uncachedInput = inputTokens + cacheCreationTokens;
	const totalInput = uncachedInput + cacheReadTokens;
	const uncachedPct = formatPercent(uncachedInput, totalInput);
	return `${formatNumber(uncachedInput)}\n${uncachedPct}`;
}
