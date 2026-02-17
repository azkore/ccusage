import type { LoadedSessionMetadata, LoadedUsageEntry } from './data-loader.ts';
import path from 'node:path';

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

	return filteredEntries;
}
