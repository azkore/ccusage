import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import pc from 'picocolors';

const USER_HOME_DIR = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
const DEFAULT_ALIAS_CONFIG_PATH = path.join(USER_HOME_DIR, '.config', 'causage', 'aliases.yaml');

type Colorizer = (text: string) => string;

type CompiledAliasRule = {
	match: string;
	replace: string;
	colorizer?: Colorizer;
};

type ParsedAliasRule = {
	match?: string;
	replace?: string;
	color?: string;
};

type AliasResolveResult = {
	label: string;
	colorizer?: Colorizer;
};

const colorizers: Record<string, Colorizer> = {
	black: pc.black,
	blue: pc.blue,
	cyan: pc.cyan,
	gray: pc.gray,
	green: pc.green,
	grey: pc.gray,
	magenta: pc.magenta,
	red: pc.red,
	white: pc.white,
	yellow: pc.yellow,
};

function supportsTrueColor(): boolean {
	if (!pc.isColorSupported) {
		return false;
	}

	const colorterm = (process.env.COLORTERM ?? '').toLowerCase();
	if (colorterm.includes('truecolor') || colorterm.includes('24bit')) {
		return true;
	}

	const term = (process.env.TERM ?? '').toLowerCase();
	return term.includes('truecolor') || term.includes('24bit');
}

function rgbToAnsi256(red: number, green: number, blue: number): number {
	if (red === green && green === blue) {
		if (red < 8) {
			return 16;
		}
		if (red > 248) {
			return 231;
		}

		return Math.round(((red - 8) / 247) * 24) + 232;
	}

	const toCube = (value: number): number => Math.round((value / 255) * 5);
	return 16 + 36 * toCube(red) + 6 * toCube(green) + toCube(blue);
}

function createAnsiColorizer(openCode: string): Colorizer {
	return (text: string) => {
		if (!pc.isColorSupported) {
			return text;
		}

		return `\u001B[${openCode}m${text}\u001B[39m`;
	};
}

function parseHexColor(hexColor: string): Colorizer | undefined {
	const hex = hexColor.trim().toLowerCase();
	const match = hex.match(/^#([a-f0-9]{3}|[a-f0-9]{6})$/);
	if (match?.[1] == null) {
		return undefined;
	}

	const normalizedHex =
		match[1].length === 3
			? `${match[1][0]}${match[1][0]}${match[1][1]}${match[1][1]}${match[1][2]}${match[1][2]}`
			: match[1];
	const red = Number.parseInt(normalizedHex.slice(0, 2), 16);
	const green = Number.parseInt(normalizedHex.slice(2, 4), 16);
	const blue = Number.parseInt(normalizedHex.slice(4, 6), 16);
	if (supportsTrueColor()) {
		return createAnsiColorizer(`38;2;${red};${green};${blue}`);
	}

	const fallbackColor = rgbToAnsi256(red, green, blue);
	return createAnsiColorizer(`38;5;${fallbackColor}`);
}

function parseAnsi256Color(value: string): Colorizer | undefined {
	const match = value
		.trim()
		.toLowerCase()
		.match(/^ansi256:(\d{1,3})$/);
	if (match?.[1] == null) {
		return undefined;
	}

	const index = Number.parseInt(match[1], 10);
	if (Number.isNaN(index) || index < 0 || index > 255) {
		return undefined;
	}

	return createAnsiColorizer(`38;5;${index}`);
}

function resolveColorizer(colorSpec: string): Colorizer | undefined {
	const normalized = colorSpec.trim().toLowerCase();
	if (normalized === '') {
		return undefined;
	}

	const namedColor = colorizers[normalized];
	if (namedColor != null) {
		return namedColor;
	}

	return parseHexColor(normalized) ?? parseAnsi256Color(normalized);
}

let cachedRules: CompiledAliasRule[] | null = null;
let aliasEnabled = false;

export function setModelAliasEnabled(enabled: boolean): void {
	aliasEnabled = enabled;
}

function compileRulesFromConfig(configValue: ParsedAliasRule[]): CompiledAliasRule[] {
	const compiled: CompiledAliasRule[] = [];
	for (const rule of configValue) {
		const match = typeof rule.match === 'string' ? rule.match.trim() : '';
		const replace = typeof rule.replace === 'string' ? rule.replace.trim() : '';
		if (match === '' || replace === '') {
			continue;
		}

		const colorName = typeof rule.color === 'string' ? rule.color.trim() : '';
		compiled.push({
			match,
			replace,
			colorizer: resolveColorizer(colorName),
		});
	}

	return compiled;
}

function unquote(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length < 2) {
		return trimmed;
	}

	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}

	return trimmed;
}

function assignRuleField(line: string, rule: ParsedAliasRule): void {
	const colonIndex = line.indexOf(':');
	if (colonIndex < 0) {
		return;
	}

	const key = line.slice(0, colonIndex).trim();
	const value = unquote(line.slice(colonIndex + 1));

	if (key === 'match') {
		rule.match = value;
	} else if (key === 'replace') {
		rule.replace = value;
	} else if (key === 'color') {
		rule.color = value;
	}
}

function parseAliasYaml(rawConfig: string): ParsedAliasRule[] {
	const rules: ParsedAliasRule[] = [];
	let inRulesSection = false;
	let currentRule: ParsedAliasRule | null = null;

	for (const rawLine of rawConfig.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (line === '' || line.startsWith('#')) {
			continue;
		}

		if (!inRulesSection) {
			if (line === 'rules:') {
				inRulesSection = true;
			}
			continue;
		}

		if (line.startsWith('-')) {
			if (currentRule != null) {
				rules.push(currentRule);
			}
			currentRule = {};

			const inlineEntry = line.slice(1).trim();
			if (inlineEntry !== '') {
				assignRuleField(inlineEntry, currentRule);
			}
			continue;
		}

		if (currentRule == null) {
			continue;
		}

		assignRuleField(line, currentRule);
	}

	if (currentRule != null) {
		rules.push(currentRule);
	}

	return rules;
}

function loadAliasRules(): CompiledAliasRule[] {
	if (cachedRules != null) {
		return cachedRules;
	}

	if (!existsSync(DEFAULT_ALIAS_CONFIG_PATH)) {
		cachedRules = [];
		return cachedRules;
	}

	try {
		const rawConfig = readFileSync(DEFAULT_ALIAS_CONFIG_PATH, 'utf-8');
		const parsedConfig = parseAliasYaml(rawConfig);
		cachedRules = compileRulesFromConfig(parsedConfig);
		return cachedRules;
	} catch {
		cachedRules = [];
		return cachedRules;
	}
}

export function resolveModelAlias(modelLabel: string): AliasResolveResult {
	if (!aliasEnabled) {
		return { label: modelLabel };
	}

	for (const rule of loadAliasRules()) {
		if (!modelLabel.includes(rule.match)) {
			continue;
		}

		return {
			label: modelLabel.replace(rule.match, rule.replace),
			colorizer: rule.colorizer,
		};
	}

	return { label: modelLabel };
}

export function applyModelAlias(modelLabel: string): string {
	const resolved = resolveModelAlias(modelLabel);
	return resolved.colorizer?.(resolved.label) ?? resolved.label;
}
