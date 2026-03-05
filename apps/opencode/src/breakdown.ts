import type { Colorizer } from './model-alias.ts';
import { resolveModelAlias } from './model-alias.ts';

export type BreakdownDimension =
	| 'source'
	| 'provider'
	| 'model'
	| 'full-model'
	| 'cost'
	| 'percent'
	| 'project'
	| 'session';

export function resolveBreakdownDimensions(args: {
	full: boolean;
	breakdownInput: string;
	available: BreakdownDimension[];
}): BreakdownDimension[] {
	if (args.full) {
		return [...args.available];
	}

	if (args.breakdownInput.trim() === '') {
		return [];
	}

	const parsed = args.breakdownInput
		.split(',')
		.map((token) => token.trim().toLowerCase())
		.filter((token) => token !== '');

	if (parsed.length === 0) {
		return [];
	}

	if (parsed.includes('none')) {
		return [];
	}

	const allowed = new Set(args.available);
	const selected = new Set<BreakdownDimension>();
	for (const token of parsed) {
		if (!allowed.has(token as BreakdownDimension)) {
			const available = args.available.join(', ');
			throw new Error(
				`Invalid --breakdown value '${token}'. Available: ${available}${available === '' ? '(none)' : ''}`,
			);
		}
		selected.add(token as BreakdownDimension);
	}

	return args.available.filter((dimension) => selected.has(dimension));
}

export function formatSourceLabel(source: 'opencode' | 'claude' | 'codex'): string {
	if (source === 'claude') {
		return 'Claude';
	}
	if (source === 'codex') {
		return 'Codex';
	}
	return 'OpenCode';
}

export function formatReportSourceLabel(source: 'opencode' | 'claude' | 'codex' | 'all'): string {
	if (source === 'claude') {
		return 'Claude';
	}
	if (source === 'codex') {
		return 'Codex';
	}
	if (source === 'all') {
		return 'All Sources';
	}

	return 'OpenCode';
}

export function formatBreakdownLabelForTable(label: string, colorizer?: Colorizer): string {
	const color = colorizer ?? resolveModelAlias(label).colorizer;
	const slashIndex = label.lastIndexOf('/');
	if (slashIndex <= 0 || slashIndex >= label.length - 1) {
		return color?.(label) ?? label;
	}

	const formattedLabel = `${label.slice(0, slashIndex + 1)}\n${label.slice(slashIndex + 1)}`;
	return color?.(formattedLabel) ?? formattedLabel;
}

export function isDisplayedZeroCost(totalCost: number): boolean {
	return Math.abs(totalCost) < 0.005;
}
