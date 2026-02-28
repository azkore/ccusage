import type { LoadedSessionMetadata, LoadedUsageEntry } from './data-loader.ts';
import path from 'node:path';
import { normalizeModelName } from './model-display.ts';

export function extractProjectName(directory: string, projectID: string): string {
	if (directory !== 'unknown' && directory.trim() !== '') {
		const base = path.basename(directory);
		if (base !== '') {
			return base;
		}
	}

	if (projectID.trim() !== '') {
		return projectID;
	}

	return 'unknown';
}

export function matchesProjectFilter(
	metadata: LoadedSessionMetadata | undefined,
	projectFilter: string,
): boolean {
	if (projectFilter === '') {
		return true;
	}

	const normalizedFilter = projectFilter.toLowerCase();
	const projectName = extractProjectName(
		metadata?.directory ?? 'unknown',
		metadata?.projectID ?? '',
	);
	const directory = metadata?.directory ?? '';
	const projectID = metadata?.projectID ?? '';

	return (
		projectName.toLowerCase().includes(normalizedFilter) ||
		directory.toLowerCase().includes(normalizedFilter) ||
		projectID.toLowerCase().includes(normalizedFilter)
	);
}

export function filterEntriesBySessionProjectFilters(
	entries: LoadedUsageEntry[],
	sessionMetadataMap: Map<string, LoadedSessionMetadata>,
	args: {
		idInput: string;
		projectInput: string;
		modelInput: string;
		providerInput: string;
		fullModelInput: string;
	},
): LoadedUsageEntry[] {
	let filteredEntries = entries;

	if (args.idInput !== '') {
		filteredEntries = filteredEntries.filter((entry) => entry.sessionID === args.idInput);
	}

	if (args.projectInput !== '') {
		filteredEntries = filteredEntries.filter((entry) =>
			matchesProjectFilter(sessionMetadataMap.get(entry.sessionID), args.projectInput),
		);
	}

	if (args.modelInput !== '') {
		filteredEntries = filteredEntries.filter((entry) => matchesModelFilter(entry, args.modelInput));
	}

	if (args.providerInput !== '') {
		filteredEntries = filteredEntries.filter((entry) =>
			matchesProviderFilter(entry, args.providerInput),
		);
	}

	if (args.fullModelInput !== '') {
		filteredEntries = filteredEntries.filter((entry) =>
			matchesFullModelFilter(entry, args.fullModelInput),
		);
	}

	return filteredEntries;
}

export function matchesModelFilter(entry: LoadedUsageEntry, modelFilter: string): boolean {
	if (modelFilter === '') {
		return true;
	}

	const normalizedFilter = modelFilter.toLowerCase();
	const normalizedModel = normalizeModelName(entry.model, entry.provider).toLowerCase();

	return normalizedModel.includes(normalizedFilter);
}

export function matchesProviderFilter(entry: LoadedUsageEntry, providerFilter: string): boolean {
	if (providerFilter === '') {
		return true;
	}

	return entry.provider.toLowerCase().includes(providerFilter.toLowerCase());
}

export function matchesFullModelFilter(entry: LoadedUsageEntry, fullModelFilter: string): boolean {
	if (fullModelFilter === '') {
		return true;
	}

	const normalizedModel = normalizeModelName(entry.model, entry.provider);
	const fullModel = `${entry.source}/${entry.provider}/${normalizedModel}`.toLowerCase();

	return fullModel.includes(fullModelFilter.toLowerCase());
}

if (import.meta.vitest != null) {
	const { describe, it, expect } = import.meta.vitest;

	const baseEntry: LoadedUsageEntry = {
		timestamp: new Date('2026-01-01T00:00:00Z'),
		sessionID: 'session-1',
		source: 'opencode',
		provider: 'openai',
		model: 'gpt-5.3-codex',
		costUSD: 1,
		usage: {
			inputTokens: 1,
			outputTokens: 1,
			reasoningTokens: 0,
			cacheCreationInputTokens: 0,
			cacheReadInputTokens: 0,
		},
	};

	describe('matchesModelFilter', () => {
		it('matches by model substring', () => {
			expect(matchesModelFilter(baseEntry, '5.3')).toBe(true);
		});

		it('does not match provider in model-only filter', () => {
			expect(matchesModelFilter(baseEntry, 'openai')).toBe(false);
		});

		it('handles model that already contains provider prefix', () => {
			const prefixedEntry: LoadedUsageEntry = {
				...baseEntry,
				model: 'openai/gpt-5.2-codex',
			};

			expect(matchesModelFilter(prefixedEntry, 'gpt-5.2')).toBe(true);
			expect(matchesModelFilter(prefixedEntry, 'openai')).toBe(false);
		});

		it('returns false when no candidate matches', () => {
			expect(matchesModelFilter(baseEntry, 'claude')).toBe(false);
		});
	});

	describe('matchesProviderFilter', () => {
		it('matches provider substring', () => {
			expect(matchesProviderFilter(baseEntry, 'open')).toBe(true);
		});

		it('returns false for non-matching provider', () => {
			expect(matchesProviderFilter(baseEntry, 'anthropic')).toBe(false);
		});
	});

	describe('matchesFullModelFilter', () => {
		it('matches source/provider/model composite', () => {
			expect(matchesFullModelFilter(baseEntry, 'opencode/openai/gpt-5.3')).toBe(true);
		});

		it('does not match mismatched source', () => {
			expect(matchesFullModelFilter(baseEntry, 'claude/openai/gpt-5.3')).toBe(false);
		});
	});
}
