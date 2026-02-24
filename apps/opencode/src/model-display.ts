import type { LoadedUsageEntry } from './data-loader.ts';

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
	const slashIndex = modelLabel.indexOf('/');
	if (slashIndex <= 0) {
		const dateLikeSuffix = modelLabel.match(/-(\d{6,})$/);
		if (dateLikeSuffix == null || dateLikeSuffix.index == null) {
			return modelLabel;
		}

		return `${modelLabel.slice(0, dateLikeSuffix.index + 1)}\n${modelLabel.slice(dateLikeSuffix.index + 1)}`;
	}

	return `${modelLabel.slice(0, slashIndex + 1)}\n${modelLabel.slice(slashIndex + 1)}`;
}
