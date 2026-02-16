export const DATE_FILTER_FORMAT_HINT =
	'YYYYMMDD, YYYYMMDDHHMM, YYYY-MM-DD, YYYY-MM-DDTHH:MM, or ISO datetime';
export const LAST_DURATION_FORMAT_HINT = '15m, 2h, 3d, or 1w';

type DateBoundary = 'since' | 'until';

const DURATION_MULTIPLIER_MS = {
	m: 60 * 1000,
	h: 60 * 60 * 1000,
	d: 24 * 60 * 60 * 1000,
	w: 7 * 24 * 60 * 60 * 1000,
} as const;

function buildLocalDate(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number,
	millisecond: number,
): Date | null {
	const date = new Date(year, month - 1, day, hour, minute, second, millisecond);

	if (Number.isNaN(date.getTime())) {
		return null;
	}

	if (
		date.getFullYear() !== year ||
		date.getMonth() !== month - 1 ||
		date.getDate() !== day ||
		date.getHours() !== hour ||
		date.getMinutes() !== minute ||
		date.getSeconds() !== second ||
		date.getMilliseconds() !== millisecond
	) {
		return null;
	}

	return date;
}

function parseMatchedParts(
	parts: RegExpMatchArray,
	boundary: DateBoundary,
	hasTime: boolean,
): Date | null {
	const year = Number.parseInt(parts[1] ?? '', 10);
	const month = Number.parseInt(parts[2] ?? '', 10);
	const day = Number.parseInt(parts[3] ?? '', 10);

	if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
		return null;
	}

	const hour = hasTime ? Number.parseInt(parts[4] ?? '', 10) : boundary === 'since' ? 0 : 23;
	const minute = hasTime ? Number.parseInt(parts[5] ?? '', 10) : boundary === 'since' ? 0 : 59;

	if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
		return null;
	}

	const second = boundary === 'since' ? 0 : 59;
	const millisecond = boundary === 'since' ? 0 : 999;

	return buildLocalDate(year, month, day, hour, minute, second, millisecond);
}

export function formatLocalDateKey(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

export function formatLocalMonthKey(date: Date): string {
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	return `${year}-${month}`;
}

export function parseDateFilterValue(value: string, boundary: DateBoundary): Date | null {
	const trimmed = value.trim();
	if (trimmed === '') {
		return null;
	}

	const compactDateTimeMatch = trimmed.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
	if (compactDateTimeMatch != null) {
		return parseMatchedParts(compactDateTimeMatch, boundary, true);
	}

	const compactDateMatch = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
	if (compactDateMatch != null) {
		return parseMatchedParts(compactDateMatch, boundary, false);
	}

	const dashedDateTimeMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
	if (dashedDateTimeMatch != null) {
		return parseMatchedParts(dashedDateTimeMatch, boundary, true);
	}

	const dashedDateMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (dashedDateMatch != null) {
		return parseMatchedParts(dashedDateMatch, boundary, false);
	}

	const parsed = new Date(trimmed);
	if (Number.isNaN(parsed.getTime())) {
		return null;
	}

	return parsed;
}

function parseLastDuration(value: string): number | null {
	const trimmed = value.trim();
	const match = trimmed.match(/^(\d+)([mhdw])$/i);
	if (match == null) {
		return null;
	}

	const amount = Number.parseInt(match[1] ?? '', 10);
	const unit = (match[2] ?? '').toLowerCase() as keyof typeof DURATION_MULTIPLIER_MS;
	if (!Number.isFinite(amount) || amount <= 0) {
		return null;
	}

	const multiplier = DURATION_MULTIPLIER_MS[unit];
	if (multiplier == null) {
		return null;
	}

	return amount * multiplier;
}

export function resolveDateRangeFilters(args: {
	sinceInput: string;
	untilInput: string;
	lastInput: string;
	now?: Date;
}): { sinceDate: Date | null; untilDate: Date | null } {
	const sinceInput = args.sinceInput.trim();
	const untilInput = args.untilInput.trim();
	const lastInput = args.lastInput.trim();

	if (lastInput !== '' && (sinceInput !== '' || untilInput !== '')) {
		throw new Error('--last cannot be used with --since or --until');
	}

	if (lastInput !== '') {
		const durationMs = parseLastDuration(lastInput);
		if (durationMs == null) {
			throw new Error(`Invalid --last value: ${lastInput}. Use ${LAST_DURATION_FORMAT_HINT}.`);
		}

		const now = args.now ?? new Date();
		return {
			sinceDate: new Date(now.getTime() - durationMs),
			untilDate: now,
		};
	}

	const sinceDate = sinceInput !== '' ? parseDateFilterValue(sinceInput, 'since') : null;
	const untilDate = untilInput !== '' ? parseDateFilterValue(untilInput, 'until') : null;

	if (sinceInput !== '' && sinceDate == null) {
		throw new Error(`Invalid --since value: ${sinceInput}. Use ${DATE_FILTER_FORMAT_HINT}.`);
	}

	if (untilInput !== '' && untilDate == null) {
		throw new Error(`Invalid --until value: ${untilInput}. Use ${DATE_FILTER_FORMAT_HINT}.`);
	}

	if (sinceDate != null && untilDate != null && sinceDate.getTime() > untilDate.getTime()) {
		throw new Error('--since must be earlier than or equal to --until');
	}

	return { sinceDate, untilDate };
}

export function filterEntriesByDateRange<T extends { timestamp: Date }>(
	entries: T[],
	sinceDate: Date | null,
	untilDate: Date | null,
): T[] {
	return entries.filter((entry) => {
		if (sinceDate != null && entry.timestamp < sinceDate) {
			return false;
		}
		if (untilDate != null && entry.timestamp > untilDate) {
			return false;
		}
		return true;
	});
}
