export const DATE_FILTER_FORMAT_HINT =
	'YYYYMMDD, YYYYMMDDHHMM, YYYY-MM-DD, YYYY-MM-DDTHH:MM, or ISO datetime';

type DateBoundary = 'since' | 'until';

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
