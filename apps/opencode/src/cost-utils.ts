import type { LiteLLMModelPricing, LiteLLMPricingFetcher } from '@ccusage/internal/pricing';
import type { LoadedUsageEntry } from './data-loader.ts';
import { formatNumber } from '@ccusage/terminal/table';
import { Result } from '@praha/byethrow';

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
			output_tokens: entry.usage.outputTokens,
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
	inputCost: number;
	outputCost: number;
	cacheReadCost: number;
};

/**
 * Calculate per-component costs using the model's actual pricing.
 * Computes input cost (net input + cache creation), output cost,
 * and cache read cost separately using LiteLLM pricing data.
 */
export async function calculateComponentCosts(
	tokens: {
		inputTokens: number;
		outputTokens: number;
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
		return { inputCost: 0, outputCost: 0, cacheReadCost: 0 };
	}

	// Input cost: net input tokens + cache creation tokens (non-cached input)
	const inputCost = fetcher.calculateCostFromPricing(
		{
			input_tokens: tokens.inputTokens,
			output_tokens: 0,
			cache_creation_input_tokens: tokens.cacheCreationTokens,
		},
		pricing,
	);

	// Output cost only
	const outputCost = fetcher.calculateCostFromPricing(
		{
			input_tokens: 0,
			output_tokens: tokens.outputTokens,
		},
		pricing,
	);

	// Cache read cost only
	const cacheReadCost = fetcher.calculateCostFromPricing(
		{
			input_tokens: 0,
			output_tokens: 0,
			cache_read_input_tokens: tokens.cacheReadTokens,
		},
		pricing,
	);

	return { inputCost, outputCost, cacheReadCost };
}

// ── Display formatting helpers ──────────────────────────────────────

/**
 * Format effective blended rate as $/M
 */
function formatRate(cost: number, tokens: number): string {
	if (tokens <= 0) {
		return '';
	}
	const perMillion = (cost / tokens) * MILLION;
	return `$${perMillion.toFixed(2)}/M`;
}

/**
 * Aggregated token data for a single model (used in breakdown rows)
 */
export type ModelTokenData = {
	inputTokens: number;
	outputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
	totalCost: number;
};

/**
 * Format the "Input" column value: total input-side tokens with $/M rate.
 * Rate is the effective blended rate for non-cached input (net input + cache create).
 * When componentCosts is provided, shows the rate in parentheses.
 */
export function formatInputColumn(data: ModelTokenData, componentCosts?: ComponentCosts): string {
	const totalInput = data.inputTokens + data.cacheCreationTokens + data.cacheReadTokens;
	if (componentCosts == null) {
		return formatNumber(totalInput);
	}
	const nonCachedInput = data.inputTokens + data.cacheCreationTokens;
	const rate = formatRate(componentCosts.inputCost, nonCachedInput);
	return rate !== '' ? `${formatNumber(totalInput)} (${rate})` : formatNumber(totalInput);
}

/**
 * Format the "Output" column value: output tokens with $/M rate.
 */
export function formatOutputColumn(data: ModelTokenData, componentCosts?: ComponentCosts): string {
	if (componentCosts == null) {
		return formatNumber(data.outputTokens);
	}
	const rate = formatRate(componentCosts.outputCost, data.outputTokens);
	return rate !== ''
		? `${formatNumber(data.outputTokens)} (${rate})`
		: formatNumber(data.outputTokens);
}

/**
 * Format the "Cache Hit" column value: percentage with $/M rate for cache reads.
 * Cache hit % = cacheRead / (input + cacheCreate + cacheRead)
 */
export function formatCacheHitColumn(
	data: ModelTokenData,
	componentCosts?: ComponentCosts,
): string {
	const totalInput = data.inputTokens + data.cacheCreationTokens + data.cacheReadTokens;
	if (totalInput <= 0) {
		return '0%';
	}
	const pct = ((data.cacheReadTokens / totalInput) * 100).toFixed(0);
	if (componentCosts == null) {
		return `${pct}%`;
	}
	const rate = formatRate(componentCosts.cacheReadCost, data.cacheReadTokens);
	return rate !== '' ? `${pct}% (${rate})` : `${pct}%`;
}

/**
 * Compute cache hit % for an aggregate of multiple models (no $/M rate).
 */
export function formatAggregateCacheHit(
	inputTokens: number,
	cacheCreationTokens: number,
	cacheReadTokens: number,
): string {
	const totalInput = inputTokens + cacheCreationTokens + cacheReadTokens;
	if (totalInput <= 0) {
		return '0%';
	}
	return `${((cacheReadTokens / totalInput) * 100).toFixed(0)}%`;
}

/**
 * Compute total input tokens (net input + cache create + cache read)
 */
export function totalInputTokens(data: ModelTokenData): number {
	return data.inputTokens + data.cacheCreationTokens + data.cacheReadTokens;
}
