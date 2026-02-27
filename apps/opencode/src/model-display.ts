import type { LoadedUsageEntry } from './data-loader.ts';
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

export function formatModelLabelForTable(modelLabel: string): string {
	const resolvedAlias = resolveModelAlias(modelLabel);
	const plainLabel = resolvedAlias.label;
	const slashIndex = plainLabel.indexOf('/');
	if (slashIndex <= 0) {
		const dateLikeSuffix = plainLabel.match(/-(\d{6,})$/);
		if (dateLikeSuffix == null || dateLikeSuffix.index == null) {
			return resolvedAlias.colorizer?.(plainLabel) ?? plainLabel;
		}

		const formattedLabel = `${plainLabel.slice(0, dateLikeSuffix.index + 1)}\n${plainLabel.slice(dateLikeSuffix.index + 1)}`;
		return resolvedAlias.colorizer?.(formattedLabel) ?? formattedLabel;
	}

	const formattedLabel = `${plainLabel.slice(0, slashIndex + 1)}\n${plainLabel.slice(slashIndex + 1)}`;
	return resolvedAlias.colorizer?.(formattedLabel) ?? formattedLabel;
}

export function applyModelAliasForDisplay(modelLabel: string): string {
	return applyModelAlias(modelLabel);
}
