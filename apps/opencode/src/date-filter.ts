export const DATE_FILTER_FORMAT_HINT =
	'YYYYMMDD, YYYYMMDDHHMM, YYYY-MM-DD, YYYY-MM-DDTHH:MM, MMDD, MM-DD, MM-DDTHH:MM, HH:MM, or ISO datetime';
export const LAST_DURATION_FORMAT_HINT = '15m, 2h, 3d, or 1w';

type DateBoundary = 'since' | 'until';
type DateFilterOptions = { useUTC?: boolean };

const DURATION_MULTIPLIER_MS = {
	m: 60 * 1000,
	h: 60 * 60 * 1000,
	d: 24 * 60 * 60 * 1000,
	w: 7 * 24 * 60 * 60 * 1000,
} as const;

function buildDate(
	year: number,
	month: number,
	day: number,
	hour: number,
	minute: number,
	second: number,
	millisecond: number,
	useUTC: boolean,
): Date | null {
	const date = useUTC
		? new Date(Date.UTC(year, month - 1, day, hour, minute, second, millisecond))
		: new Date(year, month - 1, day, hour, minute, second, millisecond);

	if (Number.isNaN(date.getTime())) {
		return null;
	}

	const actualYear = useUTC ? date.getUTCFullYear() : date.getFullYear();
	const actualMonth = useUTC ? date.getUTCMonth() : date.getMonth();
	const actualDay = useUTC ? date.getUTCDate() : date.getDate();
	const actualHour = useUTC ? date.getUTCHours() : date.getHours();
	const actualMinute = useUTC ? date.getUTCMinutes() : date.getMinutes();
	const actualSecond = useUTC ? date.getUTCSeconds() : date.getSeconds();
	const actualMillisecond = useUTC ? date.getUTCMilliseconds() : date.getMilliseconds();

	if (
		actualYear !== year ||
		actualMonth !== month - 1 ||
		actualDay !== day ||
		actualHour !== hour ||
		actualMinute !== minute ||
		actualSecond !== second ||
		actualMillisecond !== millisecond
	) {
		return null;
	}

	return date;
}

function parseDateValues(args: {
	year: number;
	month: number;
	day: number;
	boundary: DateBoundary;
	useUTC?: boolean;
	hour?: number;
	minute?: number;
}): Date | null {
	const year = args.year;
	const month = args.month;
	const day = args.day;

	if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
		return null;
	}

	const hour = args.hour ?? (args.boundary === 'since' ? 0 : 23);
	const minute = args.minute ?? (args.boundary === 'since' ? 0 : 59);

	if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
		return null;
	}

	const second = args.boundary === 'since' ? 0 : 59;
	const millisecond = args.boundary === 'since' ? 0 : 999;
	const useUTC = args.useUTC ?? false;

	return buildDate(year, month, day, hour, minute, second, millisecond, useUTC);
}

export function formatDateKey(date: Date, useUTC = false): string {
	const year = useUTC ? date.getUTCFullYear() : date.getFullYear();
	const month = String((useUTC ? date.getUTCMonth() : date.getMonth()) + 1).padStart(2, '0');
	const day = String(useUTC ? date.getUTCDate() : date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

export function formatMonthKey(date: Date, useUTC = false): string {
	const year = useUTC ? date.getUTCFullYear() : date.getFullYear();
	const month = String((useUTC ? date.getUTCMonth() : date.getMonth()) + 1).padStart(2, '0');
	return `${year}-${month}`;
}

export function formatLocalDateKey(date: Date): string {
	return formatDateKey(date, false);
}

export function formatLocalMonthKey(date: Date): string {
	return formatMonthKey(date, false);
}

export function parseDateFilterValue(
	value: string,
	boundary: DateBoundary,
	referenceDate: Date = new Date(),
	options: DateFilterOptions = {},
): Date | null {
	const useUTC = options.useUTC ?? false;
	const trimmed = value.trim();
	if (trimmed === '') {
		return null;
	}

	const timeOnlyMatch = trimmed.match(/^(\d{1,2}):(\d{2})$/);
	if (timeOnlyMatch != null) {
		const hour = Number.parseInt(timeOnlyMatch[1] ?? '', 10);
		const minute = Number.parseInt(timeOnlyMatch[2] ?? '', 10);
		if (
			!Number.isFinite(hour) ||
			!Number.isFinite(minute) ||
			hour < 0 ||
			hour > 23 ||
			minute < 0 ||
			minute > 59
		) {
			return null;
		}

		const second = boundary === 'since' ? 0 : 59;
		const millisecond = boundary === 'since' ? 0 : 999;
		return buildDate(
			useUTC ? referenceDate.getUTCFullYear() : referenceDate.getFullYear(),
			(useUTC ? referenceDate.getUTCMonth() : referenceDate.getMonth()) + 1,
			useUTC ? referenceDate.getUTCDate() : referenceDate.getDate(),
			hour,
			minute,
			second,
			millisecond,
			useUTC,
		);
	}

	const compactDateTimeMatch = trimmed.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})$/);
	if (compactDateTimeMatch != null) {
		return parseDateValues({
			year: Number.parseInt(compactDateTimeMatch[1] ?? '', 10),
			month: Number.parseInt(compactDateTimeMatch[2] ?? '', 10),
			day: Number.parseInt(compactDateTimeMatch[3] ?? '', 10),
			hour: Number.parseInt(compactDateTimeMatch[4] ?? '', 10),
			minute: Number.parseInt(compactDateTimeMatch[5] ?? '', 10),
			useUTC,
			boundary,
		});
	}

	const compactDateMatch = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
	if (compactDateMatch != null) {
		return parseDateValues({
			year: Number.parseInt(compactDateMatch[1] ?? '', 10),
			month: Number.parseInt(compactDateMatch[2] ?? '', 10),
			day: Number.parseInt(compactDateMatch[3] ?? '', 10),
			useUTC,
			boundary,
		});
	}

	const compactDateWithoutYearMatch = trimmed.match(/^(\d{2})(\d{2})$/);
	if (compactDateWithoutYearMatch != null) {
		return parseDateValues({
			year: useUTC ? referenceDate.getUTCFullYear() : referenceDate.getFullYear(),
			month: Number.parseInt(compactDateWithoutYearMatch[1] ?? '', 10),
			day: Number.parseInt(compactDateWithoutYearMatch[2] ?? '', 10),
			useUTC,
			boundary,
		});
	}

	const dashedDateTimeMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
	if (dashedDateTimeMatch != null) {
		return parseDateValues({
			year: Number.parseInt(dashedDateTimeMatch[1] ?? '', 10),
			month: Number.parseInt(dashedDateTimeMatch[2] ?? '', 10),
			day: Number.parseInt(dashedDateTimeMatch[3] ?? '', 10),
			hour: Number.parseInt(dashedDateTimeMatch[4] ?? '', 10),
			minute: Number.parseInt(dashedDateTimeMatch[5] ?? '', 10),
			useUTC,
			boundary,
		});
	}

	const dashedDateMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (dashedDateMatch != null) {
		return parseDateValues({
			year: Number.parseInt(dashedDateMatch[1] ?? '', 10),
			month: Number.parseInt(dashedDateMatch[2] ?? '', 10),
			day: Number.parseInt(dashedDateMatch[3] ?? '', 10),
			useUTC,
			boundary,
		});
	}

	const dashedDateTimeWithoutYearMatch = trimmed.match(/^(\d{1,2})-(\d{1,2})[ T](\d{2}):(\d{2})$/);
	if (dashedDateTimeWithoutYearMatch != null) {
		return parseDateValues({
			year: useUTC ? referenceDate.getUTCFullYear() : referenceDate.getFullYear(),
			month: Number.parseInt(dashedDateTimeWithoutYearMatch[1] ?? '', 10),
			day: Number.parseInt(dashedDateTimeWithoutYearMatch[2] ?? '', 10),
			hour: Number.parseInt(dashedDateTimeWithoutYearMatch[3] ?? '', 10),
			minute: Number.parseInt(dashedDateTimeWithoutYearMatch[4] ?? '', 10),
			useUTC,
			boundary,
		});
	}

	const dashedDateWithoutYearMatch = trimmed.match(/^(\d{1,2})-(\d{1,2})$/);
	if (dashedDateWithoutYearMatch != null) {
		return parseDateValues({
			year: useUTC ? referenceDate.getUTCFullYear() : referenceDate.getFullYear(),
			month: Number.parseInt(dashedDateWithoutYearMatch[1] ?? '', 10),
			day: Number.parseInt(dashedDateWithoutYearMatch[2] ?? '', 10),
			useUTC,
			boundary,
		});
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
	useUTC?: boolean;
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

	const now = args.now ?? new Date();
	const options: DateFilterOptions = { useUTC: args.useUTC };
	const sinceDate =
		sinceInput !== '' ? parseDateFilterValue(sinceInput, 'since', now, options) : null;
	const untilDate =
		untilInput !== '' ? parseDateFilterValue(untilInput, 'until', now, options) : null;

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

if (import.meta.vitest != null) {
	const { describe, expect, it } = import.meta.vitest;

	describe('parseDateFilterValue', () => {
		it('parses time-only --since as today local time', () => {
			const referenceDate = new Date('2026-03-01T12:30:00Z');
			const parsed = parseDateFilterValue('05:00', 'since', referenceDate);
			expect(parsed).not.toBeNull();
			expect(parsed?.getFullYear()).toBe(referenceDate.getFullYear());
			expect(parsed?.getMonth()).toBe(referenceDate.getMonth());
			expect(parsed?.getDate()).toBe(referenceDate.getDate());
			expect(parsed?.getHours()).toBe(5);
			expect(parsed?.getMinutes()).toBe(0);
			expect(parsed?.getSeconds()).toBe(0);
			expect(parsed?.getMilliseconds()).toBe(0);
		});

		it('parses time-only --until as end of minute today', () => {
			const referenceDate = new Date('2026-03-01T12:30:00Z');
			const parsed = parseDateFilterValue('05:00', 'until', referenceDate);
			expect(parsed).not.toBeNull();
			expect(parsed?.getHours()).toBe(5);
			expect(parsed?.getMinutes()).toBe(0);
			expect(parsed?.getSeconds()).toBe(59);
			expect(parsed?.getMilliseconds()).toBe(999);
		});

		it('rejects invalid time-only values', () => {
			expect(parseDateFilterValue('25:00', 'since')).toBeNull();
			expect(parseDateFilterValue('09:99', 'since')).toBeNull();
		});

		it('parses year-optional dashed date as current year', () => {
			const referenceDate = new Date('2026-03-01T12:30:00Z');
			const parsed = parseDateFilterValue('02-28', 'since', referenceDate);
			expect(parsed).not.toBeNull();
			expect(parsed?.getFullYear()).toBe(referenceDate.getFullYear());
			expect(parsed?.getMonth()).toBe(1);
			expect(parsed?.getDate()).toBe(28);
			expect(parsed?.getHours()).toBe(0);
			expect(parsed?.getMinutes()).toBe(0);
		});

		it('parses year-optional dashed datetime as current year', () => {
			const referenceDate = new Date('2026-03-01T12:30:00Z');
			const parsed = parseDateFilterValue('02-28 05:45', 'since', referenceDate);
			expect(parsed).not.toBeNull();
			expect(parsed?.getFullYear()).toBe(referenceDate.getFullYear());
			expect(parsed?.getMonth()).toBe(1);
			expect(parsed?.getDate()).toBe(28);
			expect(parsed?.getHours()).toBe(5);
			expect(parsed?.getMinutes()).toBe(45);
		});

		it('parses year-optional compact date as current year', () => {
			const referenceDate = new Date('2026-03-01T12:30:00Z');
			const parsed = parseDateFilterValue('0228', 'until', referenceDate);
			expect(parsed).not.toBeNull();
			expect(parsed?.getFullYear()).toBe(referenceDate.getFullYear());
			expect(parsed?.getMonth()).toBe(1);
			expect(parsed?.getDate()).toBe(28);
			expect(parsed?.getHours()).toBe(23);
			expect(parsed?.getMinutes()).toBe(59);
			expect(parsed?.getSeconds()).toBe(59);
			expect(parsed?.getMilliseconds()).toBe(999);
		});

		it('rejects invalid year-optional date in non-leap year', () => {
			const referenceDate = new Date('2025-03-01T12:30:00Z');
			expect(parseDateFilterValue('02-29', 'since', referenceDate)).toBeNull();
		});
	});

	describe('formatDateKey', () => {
		it('formats UTC key when enabled', () => {
			const date = new Date('2025-12-31T23:30:00Z');
			expect(formatDateKey(date, true)).toBe('2025-12-31');
		});

		it('formats UTC month key when enabled', () => {
			const date = new Date('2025-12-31T23:30:00Z');
			expect(formatMonthKey(date, true)).toBe('2025-12');
		});
	});
}
