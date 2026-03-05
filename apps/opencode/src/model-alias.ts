import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import pc from 'picocolors';

const USER_HOME_DIR = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
const DEFAULT_ALIAS_CONFIG_PATH = path.join(USER_HOME_DIR, '.config', 'causage', 'aliases.yaml');

export type Colorizer = (text: string) => string;

type CompiledMatcher = { type: 'substring'; value: string } | { type: 'regex'; value: RegExp };

type CompiledAliasRule = {
	matchers: CompiledMatcher[];
	replace: string;
	colorizer?: Colorizer;
};

type ParsedAliasRule = {
	match?: string | string[];
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

export function isModelAliasEnabled(): boolean {
	return aliasEnabled;
}

function compileMatcher(pattern: string): CompiledMatcher | null {
	const trimmed = pattern.trim();
	if (trimmed === '') {
		return null;
	}

	const regexMatch = trimmed.match(/^\/(.+)\/([gimsuy]*)$/);
	if (regexMatch?.[1] != null) {
		try {
			return { type: 'regex', value: new RegExp(regexMatch[1], regexMatch[2]) };
		} catch {
			return null;
		}
	}

	return { type: 'substring', value: trimmed };
}

function compileRulesFromConfig(configValue: ParsedAliasRule[]): CompiledAliasRule[] {
	const compiled: CompiledAliasRule[] = [];
	for (const rule of configValue) {
		const replace = typeof rule.replace === 'string' ? rule.replace.trim() : '';
		if (replace === '') {
			continue;
		}

		const matchPatterns = Array.isArray(rule.match)
			? rule.match
			: typeof rule.match === 'string'
				? [rule.match]
				: [];
		const matchers: CompiledMatcher[] = [];
		for (const pattern of matchPatterns) {
			const matcher = compileMatcher(pattern);
			if (matcher != null) {
				matchers.push(matcher);
			}
		}

		if (matchers.length === 0) {
			continue;
		}

		const colorName = typeof rule.color === 'string' ? rule.color.trim() : '';
		compiled.push({
			matchers,
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

function assignRuleField(key: string, value: string, rule: ParsedAliasRule): void {
	if (key === 'match') {
		rule.match = value;
	} else if (key === 'replace') {
		rule.replace = value;
	} else if (key === 'color') {
		rule.color = value;
	}
}

function indentLevel(rawLine: string): number {
	const match = rawLine.match(/^(\s*)/);
	return match?.[1]?.length ?? 0;
}

function parseAliasYaml(rawConfig: string): ParsedAliasRule[] {
	const rules: ParsedAliasRule[] = [];
	let inRulesSection = false;
	let currentRule: ParsedAliasRule | null = null;
	let inMatchArray = false;
	let ruleIndent = -1;

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

		const indent = indentLevel(rawLine);

		// Detect rule-level list items: "  - match: ..."
		// They start with "- " and are at the shallowest list indentation
		if (line.startsWith('- ')) {
			if (ruleIndent < 0) {
				ruleIndent = indent;
			}

			if (indent <= ruleIndent) {
				// New rule
				if (currentRule != null) {
					rules.push(currentRule);
				}
				currentRule = {};
				inMatchArray = false;

				const inlineEntry = line.slice(1).trim();
				if (inlineEntry !== '') {
					const colonIndex = inlineEntry.indexOf(':');
					if (colonIndex >= 0) {
						const key = inlineEntry.slice(0, colonIndex).trim();
						const rawValue = inlineEntry.slice(colonIndex + 1).trim();
						if (key === 'match' && rawValue === '') {
							inMatchArray = true;
							currentRule.match = [];
						} else {
							assignRuleField(key, unquote(rawValue), currentRule);
						}
					}
				}
				continue;
			}

			// Deeper "- " means match array item
			if (inMatchArray && currentRule != null) {
				const itemValue = unquote(line.slice(1).trim());
				if (itemValue !== '') {
					if (!Array.isArray(currentRule.match)) {
						currentRule.match = [];
					}
					currentRule.match.push(itemValue);
				}
				continue;
			}
		}

		if (currentRule == null) {
			continue;
		}

		// Non-list-item line: end match array mode
		inMatchArray = false;

		const colonIndex = line.indexOf(':');
		if (colonIndex < 0) {
			continue;
		}

		const key = line.slice(0, colonIndex).trim();
		const rawValue = line.slice(colonIndex + 1).trim();

		// "match:" with no value means array follows
		if (key === 'match' && rawValue === '') {
			inMatchArray = true;
			currentRule.match = [];
			continue;
		}

		assignRuleField(key, unquote(rawValue), currentRule);
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

function testMatcher(matcher: CompiledMatcher, label: string): boolean {
	if (matcher.type === 'substring') {
		return label.includes(matcher.value);
	}

	return matcher.value.test(label);
}

function applyMatcherReplace(matcher: CompiledMatcher, label: string, replacement: string): string {
	if (matcher.type === 'regex') {
		return label.replace(matcher.value, replacement);
	}

	return label.replace(matcher.value, replacement);
}

export function resolveModelAlias(modelLabel: string): AliasResolveResult {
	if (!aliasEnabled) {
		return { label: modelLabel };
	}

	const rules = loadAliasRules();

	for (const rule of rules) {
		for (const matcher of rule.matchers) {
			if (!testMatcher(matcher, modelLabel)) {
				continue;
			}

			return {
				label: applyMatcherReplace(matcher, modelLabel, rule.replace),
				colorizer: rule.colorizer,
			};
		}
	}

	return { label: modelLabel };
}

export function applyModelAlias(modelLabel: string): string {
	const resolved = resolveModelAlias(modelLabel);
	return resolved.colorizer?.(resolved.label) ?? resolved.label;
}

if (import.meta.vitest != null) {
	describe('parseAliasYaml', () => {
		it('parses single string match', () => {
			const yaml = `rules:\n  - match: opencode/openai\n    replace: oc-gpt`;
			const rules = parseAliasYaml(yaml);
			expect(rules).toEqual([{ match: 'opencode/openai', replace: 'oc-gpt' }]);
		});

		it('parses multi-match array', () => {
			const yaml = [
				'rules:',
				'  - match:',
				'      - opencode/openai',
				'      - codex/openai',
				'    replace: oc-gpt',
			].join('\n');
			const rules = parseAliasYaml(yaml);
			expect(rules).toEqual([{ match: ['opencode/openai', 'codex/openai'], replace: 'oc-gpt' }]);
		});

		it('parses regex match', () => {
			const yaml = `rules:\n  - match: /anthropic\\d*/\n    replace: oc-claude`;
			const rules = parseAliasYaml(yaml);
			expect(rules).toEqual([{ match: '/anthropic\\d*/', replace: 'oc-claude' }]);
		});

		it('parses mixed rules', () => {
			const yaml = [
				'rules:',
				'  - match:',
				'      - opencode/openai',
				'      - codex/openai',
				'    replace: oc-gpt',
				'    color: blue',
				'  - match: claude/anthropic',
				'    replace: claude',
			].join('\n');
			const rules = parseAliasYaml(yaml);
			expect(rules).toHaveLength(2);
			expect(rules[0]).toEqual({
				match: ['opencode/openai', 'codex/openai'],
				replace: 'oc-gpt',
				color: 'blue',
			});
			expect(rules[1]).toEqual({ match: 'claude/anthropic', replace: 'claude' });
		});
	});

	describe('compileMatcher', () => {
		it('compiles substring matcher', () => {
			const matcher = compileMatcher('opencode/openai');
			expect(matcher).toEqual({ type: 'substring', value: 'opencode/openai' });
		});

		it('compiles regex matcher', () => {
			const matcher = compileMatcher('/anthropic\\d*/');
			expect(matcher).toEqual({ type: 'regex', value: /anthropic\d*/ });
		});

		it('compiles regex with flags', () => {
			const matcher = compileMatcher('/foo/i');
			expect(matcher).toEqual({ type: 'regex', value: /foo/i });
		});

		it('returns null for empty string', () => {
			expect(compileMatcher('')).toBeNull();
		});

		it('returns null for invalid regex', () => {
			expect(compileMatcher('/[invalid/')).toBeNull();
		});
	});

	describe('compileRulesFromConfig', () => {
		it('compiles multi-match rule into multiple matchers', () => {
			const rules = compileRulesFromConfig([
				{ match: ['opencode/openai', 'codex/openai'], replace: 'oc-gpt' },
			]);
			expect(rules).toHaveLength(1);
			const rule = rules[0]!;
			expect(rule.matchers).toHaveLength(2);
			expect(rule.matchers[0]).toEqual({ type: 'substring', value: 'opencode/openai' });
			expect(rule.matchers[1]).toEqual({ type: 'substring', value: 'codex/openai' });
			expect(rule.replace).toBe('oc-gpt');
		});

		it('compiles regex match pattern', () => {
			const rules = compileRulesFromConfig([{ match: '/anthropic\\d*/', replace: 'oc-claude' }]);
			expect(rules).toHaveLength(1);
			const rule = rules[0]!;
			expect(rule.matchers).toHaveLength(1);
			expect(rule.matchers[0]!.type).toBe('regex');
		});

		it('skips rules with empty replace', () => {
			const rules = compileRulesFromConfig([{ match: 'foo', replace: '' }]);
			expect(rules).toHaveLength(0);
		});

		it('skips rules with no valid matchers', () => {
			const rules = compileRulesFromConfig([{ match: [], replace: 'bar' }]);
			expect(rules).toHaveLength(0);
		});
	});

	describe('resolveModelAlias with multi-match', () => {
		it('resolves different inputs to same alias', () => {
			const prev = aliasEnabled;
			const prevCached = cachedRules;
			aliasEnabled = true;
			cachedRules = compileRulesFromConfig([
				{ match: ['opencode/openai', 'codex/openai'], replace: 'oc-gpt' },
			]);

			const r1 = resolveModelAlias('opencode/openai');
			const r2 = resolveModelAlias('codex/openai');
			expect(r1.label).toBe('oc-gpt');
			expect(r2.label).toBe('oc-gpt');

			aliasEnabled = prev;
			cachedRules = prevCached;
		});

		it('resolves regex match', () => {
			const prev = aliasEnabled;
			const prevCached = cachedRules;
			aliasEnabled = true;
			cachedRules = compileRulesFromConfig([
				{ match: '/^opencode\\/anthropic\\d*$/', replace: 'oc-claude' },
			]);

			expect(resolveModelAlias('opencode/anthropic').label).toBe('oc-claude');
			expect(resolveModelAlias('opencode/anthropic2').label).toBe('oc-claude');
			expect(resolveModelAlias('claude/anthropic').label).toBe('claude/anthropic');

			aliasEnabled = prev;
			cachedRules = prevCached;
		});
	});
}
