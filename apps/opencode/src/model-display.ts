import type { LoadedUsageEntry } from './data-loader.ts';
import type { Colorizer } from './model-alias.ts';
import { createFullModelLabel } from './entry-filter.ts';
import { applyModelAlias, resolveModelAlias } from './model-alias.ts';

export type ProviderDisplayMode = 'always' | 'never' | 'auto';

export function normalizeModelName(model: string, provider: string): string {
	const providerPrefix = `${provider}/`;
	if (model.startsWith(providerPrefix)) {
		return model.slice(providerPrefix.length);
	}

	return model;
}

export function createModelLabelResolver(
	entries: LoadedUsageEntry[],
	providerMode: ProviderDisplayMode = 'auto',
): (entry: Pick<LoadedUsageEntry, 'model' | 'provider'>) => string {
	if (providerMode === 'always') {
		return (entry) => {
			const normalizedModel = normalizeModelName(entry.model, entry.provider);
			return `${entry.provider}/${normalizedModel}`;
		};
	}

	if (providerMode === 'never') {
		return (entry) => normalizeModelName(entry.model, entry.provider);
	}

	const providersByModel = new Map<string, Set<string>>();

	for (const entry of entries) {
		const normalizedModel = normalizeModelName(entry.model, entry.provider);
		let providers = providersByModel.get(normalizedModel);
		if (providers == null) {
			providers = new Set<string>();
			providersByModel.set(normalizedModel, providers);
		}
		providers.add(entry.provider);
	}

	const ambiguousModels = new Set<string>();
	for (const [model, providers] of providersByModel.entries()) {
		if (providers.size > 1) {
			ambiguousModels.add(model);
		}
	}

	return (entry) => {
		const normalizedModel = normalizeModelName(entry.model, entry.provider);
		return ambiguousModels.has(normalizedModel)
			? `${entry.provider}/${normalizedModel}`
			: normalizedModel;
	};
}

/**
 * Build the model-column label used for breakdown grouping and display.
 *
 * Alias replacement is applied as a plain string replacement on the final
 * model label (the same value shown in the Models column).
 */
export function resolveBreakdownModelKey(
	entry: Pick<LoadedUsageEntry, 'source' | 'provider' | 'model'>,
	dimensions: {
		source: boolean;
		provider: boolean;
		model: boolean;
		fullModel: boolean;
	},
	modelLabelFn: (entry: Pick<LoadedUsageEntry, 'model' | 'provider'>) => string,
): { key: string; colorizer?: Colorizer } {
	const parts: string[] = [];
	if (dimensions.fullModel) {
		parts.push(createFullModelLabel(entry));
	} else {
		if (dimensions.source) {
			parts.push(entry.source);
		}
		if (dimensions.provider && dimensions.model) {
			const plainModel = normalizeModelName(entry.model, entry.provider);
			parts.push(`${entry.provider}/${plainModel}`);
		} else {
			if (dimensions.provider) {
				parts.push(entry.provider);
			}
			if (dimensions.model) {
				parts.push(modelLabelFn(entry));
			}
		}
	}

	const rawLabel = parts.join('/');
	const resolved = resolveModelAlias(rawLabel);
	return { key: resolved.label, colorizer: resolved.colorizer };
}

export function formatModelLabelForTable(modelLabel: string, colorizer?: Colorizer): string {
	const color = colorizer ?? resolveModelAlias(modelLabel).colorizer;
	const slashIndex = modelLabel.indexOf('/');
	if (slashIndex <= 0) {
		const dateLikeSuffix = modelLabel.match(/-(\d{6,})$/);
		if (dateLikeSuffix == null || dateLikeSuffix.index == null) {
			return color?.(modelLabel) ?? modelLabel;
		}

		const formattedLabel = `${modelLabel.slice(0, dateLikeSuffix.index + 1)}\n${modelLabel.slice(dateLikeSuffix.index + 1)}`;
		return color?.(formattedLabel) ?? formattedLabel;
	}

	const formattedLabel = `${modelLabel.slice(0, slashIndex + 1)}\n${modelLabel.slice(slashIndex + 1)}`;
	return color?.(formattedLabel) ?? formattedLabel;
}

export function applyModelAliasForDisplay(modelLabel: string): string {
	return applyModelAlias(modelLabel);
}
