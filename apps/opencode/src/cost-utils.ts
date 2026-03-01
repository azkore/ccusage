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

/** Anthropic tiered pricing threshold (tokens). */
const TIERED_THRESHOLD = 200_000;

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

// ---------------------------------------------------------------------------
// Tier breakdown types
// ---------------------------------------------------------------------------

/**
 * Per-tier token and cost breakdown for a single token bucket.
 * When the model has tiered pricing (e.g. Anthropic >200k), tokens that
 * cross the threshold are split into base-tier and above-tier portions.
 */
export type TierBreakdown = {
	baseTierTokens: number;
	baseTierCost: number;
	/** List rate in $/M for the base tier (null = unknown). */
	baseTierRate: number | null;
	aboveTierTokens: number;
	aboveTierCost: number;
	/** List rate in $/M for the above-threshold tier (null = no tiered rate). */
	aboveTierRate: number | null;
};

function emptyTier(): TierBreakdown {
	return {
		baseTierTokens: 0,
		baseTierCost: 0,
		baseTierRate: null,
		aboveTierTokens: 0,
		aboveTierCost: 0,
		aboveTierRate: null,
	};
}

function tierTotalCost(t: TierBreakdown): number {
	return t.baseTierCost + t.aboveTierCost;
}

/**
 * Split a token count into base-tier and above-tier portions and compute cost.
 * Mirrors the logic in LiteLLM's `calculateTieredCost`.
 */
function splitTier(
	tokens: number,
	baseRatePerToken: number | undefined,
	aboveRatePerToken: number | undefined,
): {
	baseTierTokens: number;
	baseTierCost: number;
	aboveTierTokens: number;
	aboveTierCost: number;
} {
	if (tokens <= 0) {
		return { baseTierTokens: 0, baseTierCost: 0, aboveTierTokens: 0, aboveTierCost: 0 };
	}

	// No tiered rate or below threshold → everything at base rate
	if (aboveRatePerToken == null || tokens <= TIERED_THRESHOLD) {
		return {
			baseTierTokens: tokens,
			baseTierCost: tokens * (baseRatePerToken ?? 0),
			aboveTierTokens: 0,
			aboveTierCost: 0,
		};
	}

	const below = Math.min(tokens, TIERED_THRESHOLD);
	const above = tokens - below;
	return {
		baseTierTokens: below,
		baseTierCost: below * (baseRatePerToken ?? 0),
		aboveTierTokens: above,
		aboveTierCost: above * aboveRatePerToken,
	};
}

// ---------------------------------------------------------------------------
// Component-level cost breakdown
// ---------------------------------------------------------------------------

/**
 * Component-level cost breakdown with per-tier detail for each token bucket.
 */
export type ComponentCosts = {
	baseInput: TierBreakdown;
	cacheCreate: TierBreakdown;
	output: TierBreakdown;
	cacheRead: TierBreakdown;
};

export type AggregateComponentCosts = {
	inputCost: number;
	outputCost: number;
	baseInputCost: number;
	cacheCreateCost: number;
	cacheReadCost: number;
};

function emptyComponentCosts(): ComponentCosts {
	return {
		baseInput: emptyTier(),
		cacheCreate: emptyTier(),
		output: emptyTier(),
		cacheRead: emptyTier(),
	};
}

/** Extract per-million list rates from pricing and write them into a TierBreakdown. */
function setTierRates(
	tier: TierBreakdown,
	baseRatePerToken: number | undefined,
	aboveRatePerToken: number | undefined,
): void {
	tier.baseTierRate = baseRatePerToken != null ? baseRatePerToken * MILLION : null;
	tier.aboveTierRate = aboveRatePerToken != null ? aboveRatePerToken * MILLION : null;
}

/**
 * Calculate per-component costs by summing per-entry tier splits.
 * This preserves per-request tier behaviour and then scales each entry's
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
		return emptyComponentCosts();
	}

	const result = emptyComponentCosts();

	// Store list rates for display
	setTierRates(
		result.baseInput,
		pricing.input_cost_per_token,
		pricing.input_cost_per_token_above_200k_tokens,
	);
	setTierRates(
		result.cacheCreate,
		pricing.cache_creation_input_token_cost,
		pricing.cache_creation_input_token_cost_above_200k_tokens,
	);
	setTierRates(
		result.output,
		pricing.output_cost_per_token,
		pricing.output_cost_per_token_above_200k_tokens,
	);
	setTierRates(
		result.cacheRead,
		pricing.cache_read_input_token_cost,
		pricing.cache_read_input_token_cost_above_200k_tokens,
	);

	for (const entry of entries) {
		const biSplit = splitTier(
			entry.usage.inputTokens,
			pricing.input_cost_per_token,
			pricing.input_cost_per_token_above_200k_tokens,
		);
		const ccSplit = splitTier(
			entry.usage.cacheCreationInputTokens,
			pricing.cache_creation_input_token_cost,
			pricing.cache_creation_input_token_cost_above_200k_tokens,
		);
		const outSplit = splitTier(
			entry.usage.outputTokens + entry.usage.reasoningTokens,
			pricing.output_cost_per_token,
			pricing.output_cost_per_token_above_200k_tokens,
		);
		const crSplit = splitTier(
			entry.usage.cacheReadInputTokens,
			pricing.cache_read_input_token_cost,
			pricing.cache_read_input_token_cost_above_200k_tokens,
		);

		const calculatedTotal =
			biSplit.baseTierCost +
			biSplit.aboveTierCost +
			ccSplit.baseTierCost +
			ccSplit.aboveTierCost +
			outSplit.baseTierCost +
			outSplit.aboveTierCost +
			crSplit.baseTierCost +
			crSplit.aboveTierCost;

		const authoritativeTotal = entry.costUSD != null && entry.costUSD > 0 ? entry.costUSD : null;
		const scale =
			authoritativeTotal != null && calculatedTotal > 0 ? authoritativeTotal / calculatedTotal : 1;

		// Accumulate with optional authoritative scaling
		const accum = (target: TierBreakdown, split: ReturnType<typeof splitTier>): void => {
			target.baseTierTokens += split.baseTierTokens;
			target.baseTierCost += split.baseTierCost * scale;
			target.aboveTierTokens += split.aboveTierTokens;
			target.aboveTierCost += split.aboveTierCost * scale;
		};

		accum(result.baseInput, biSplit);
		accum(result.cacheCreate, ccSplit);
		accum(result.output, outSplit);
		accum(result.cacheRead, crSplit);
	}

	return result;
}

/**
 * Calculate per-column component costs for a possibly mixed-model row.
 *
 * When entries do not report cache creation tokens, aggregate tables remap
 * uncached input into the cache-create column. This function mirrors that
 * remap for costs so token columns and dollar columns stay aligned.
 */
export async function calculateAggregateComponentCostsFromEntries(
	entries: LoadedUsageEntry[],
	fetcher: LiteLLMPricingFetcher,
): Promise<AggregateComponentCosts> {
	const groupedByModel = new Map<
		string,
		{ remapped: LoadedUsageEntry[]; normal: LoadedUsageEntry[] }
	>();

	for (const entry of entries) {
		const modelEntries = groupedByModel.get(entry.model);
		if (modelEntries == null) {
			groupedByModel.set(entry.model, {
				remapped: entry.usage.cacheCreationInputTokens > 0 ? [] : [entry],
				normal: entry.usage.cacheCreationInputTokens > 0 ? [entry] : [],
			});
			continue;
		}

		if (entry.usage.cacheCreationInputTokens > 0) {
			modelEntries.normal.push(entry);
		} else {
			modelEntries.remapped.push(entry);
		}
	}

	let baseInputCost = 0;
	let cacheCreateCost = 0;
	let cacheReadCost = 0;
	let outputCost = 0;

	for (const [model, groupedEntries] of groupedByModel) {
		if (groupedEntries.normal.length > 0) {
			const componentCosts = await calculateComponentCostsFromEntries(
				groupedEntries.normal,
				model,
				fetcher,
			);
			baseInputCost += tierTotalCost(componentCosts.baseInput);
			cacheCreateCost += tierTotalCost(componentCosts.cacheCreate);
			cacheReadCost += tierTotalCost(componentCosts.cacheRead);
			outputCost += tierTotalCost(componentCosts.output);
		}

		if (groupedEntries.remapped.length > 0) {
			const componentCosts = await calculateComponentCostsFromEntries(
				groupedEntries.remapped,
				model,
				fetcher,
			);
			cacheCreateCost += tierTotalCost(componentCosts.baseInput);
			cacheCreateCost += tierTotalCost(componentCosts.cacheCreate);
			cacheReadCost += tierTotalCost(componentCosts.cacheRead);
			outputCost += tierTotalCost(componentCosts.output);
		}
	}

	return {
		inputCost: baseInputCost + cacheCreateCost + cacheReadCost,
		outputCost,
		baseInputCost,
		cacheCreateCost,
		cacheReadCost,
	};
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatRateNumber(cost: number, tokens: number): string {
	if (tokens <= 0) {
		return '0';
	}
	return ((cost / tokens) * MILLION)
		.toFixed(2)
		.replace(/\.00$/, '')
		.replace(/(\.\d)0$/, '$1');
}

function formatCurrencyValue(value: number): string {
	return `$${value.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Public types and helpers
// ---------------------------------------------------------------------------

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

export function totalInputTokens(data: {
	inputTokens: number;
	cacheCreationTokens: number;
	cacheReadTokens: number;
}): number {
	return data.inputTokens + data.cacheCreationTokens + data.cacheReadTokens;
}

// ---------------------------------------------------------------------------
// Column format functions
// ---------------------------------------------------------------------------

/** Input Total: value + real effective rate/cost. */
export function formatInputColumn(
	data: ModelTokenData,
	componentCosts?: ComponentCosts,
	options?: { hideZeroDetail?: boolean },
): string {
	const totalInput = totalInputTokens(data);

	if (componentCosts == null) {
		return formatNumber(totalInput);
	}

	const totalInputCost =
		tierTotalCost(componentCosts.baseInput) +
		tierTotalCost(componentCosts.cacheCreate) +
		tierTotalCost(componentCosts.cacheRead);
	if (options?.hideZeroDetail === true && totalInputCost <= 0) {
		return formatNumber(totalInput);
	}

	const realRate = formatRateNumber(totalInputCost, totalInput);
	return `${formatNumber(totalInput)}\n$${realRate}/M→${pc.green(formatCurrencyValue(totalInputCost))}`;
}
