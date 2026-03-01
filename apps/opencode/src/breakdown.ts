import { resolveModelAlias } from './model-alias.ts';

export type BreakdownDimension =
	| 'source'
	| 'provider'
	| 'model'
	| 'full-model'
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

export function formatSourceLabel(source: 'opencode' | 'claude'): string {
	return source === 'claude' ? 'Claude' : 'OpenCode';
}

export function formatReportSourceLabel(source: 'opencode' | 'claude' | 'all'): string {
	if (source === 'claude') {
		return 'Claude';
	}
	if (source === 'all') {
		return 'All Sources';
	}

	return 'OpenCode';
}

export function formatBreakdownLabelForTable(label: string): string {
	const resolvedAlias = resolveModelAlias(label);
	const plainLabel = resolvedAlias.label;
	const slashIndex = plainLabel.lastIndexOf('/');
	if (slashIndex <= 0 || slashIndex >= plainLabel.length - 1) {
		return resolvedAlias.colorizer?.(plainLabel) ?? plainLabel;
	}

	const formattedLabel = `${plainLabel.slice(0, slashIndex + 1)}\n${plainLabel.slice(slashIndex + 1)}`;
	return resolvedAlias.colorizer?.(formattedLabel) ?? formattedLabel;
}

export function isDisplayedZeroCost(totalCost: number): boolean {
	return Math.abs(totalCost) < 0.005;
}
