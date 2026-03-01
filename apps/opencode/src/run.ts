import process from 'node:process';
import { cli } from 'gunshi';
import { description, name, version } from '../package.json';
import {
	dailyCommand,
	modelCommand,
	monthlyCommand,
	sessionCommand,
	weeklyCommand,
} from './commands/index.ts';

const subCommands = new Map([
	['daily', dailyCommand],
	['model', modelCommand],
	['monthly', monthlyCommand],
	['session', sessionCommand],
	['weekly', weeklyCommand],
]);

const mainCommand = dailyCommand;
const DEFAULT_BREAKDOWN_VALUE = 'source,provider,cost,percent';

type CommandLike = {
	args?: Record<string, { type?: string; short?: string }>;
};

function normalizeArgsMeta(command: CommandLike): {
	longTypes: Map<string, string>;
	shortTypes: Map<string, string>;
} {
	const longTypes = new Map<string, string>();
	const shortTypes = new Map<string, string>();

	for (const [key, meta] of Object.entries(command.args ?? {})) {
		const type = meta.type ?? 'string';
		longTypes.set(`--${key}`, type);

		if (typeof meta.short === 'string' && meta.short !== '') {
			shortTypes.set(`-${meta.short}`, type);
		}
	}

	longTypes.set('--help', 'boolean');
	longTypes.set('--version', 'boolean');
	shortTypes.set('-h', 'boolean');
	shortTypes.set('-v', 'boolean');

	return { longTypes, shortTypes };
}

function assertNoUnknownFlags(command: CommandLike, args: string[]): void {
	const { longTypes, shortTypes } = normalizeArgsMeta(command);

	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token == null || token === '--') {
			break;
		}

		if (token.startsWith('--')) {
			const shortLongMatch = token.match(/^--([a-z])(?:=.*)?$/i);
			if (shortLongMatch?.[1] != null) {
				throw new Error(`Invalid flag '${token}'. Use '-${shortLongMatch[1]}' for short flags.`);
			}

			const equalsIndex = token.indexOf('=');
			const flag = equalsIndex >= 0 ? token.slice(0, equalsIndex) : token;
			const valueType = longTypes.get(flag);
			if (valueType == null) {
				throw new Error(`Unknown flag '${flag}'. Run with --help to see valid options.`);
			}

			if (equalsIndex < 0 && valueType !== 'boolean') {
				const nextToken = args[index + 1];
				if (nextToken == null || nextToken.startsWith('-')) {
					throw new Error(`Flag '${flag}' requires a value.`);
				}
				index += 1;
			}

			continue;
		}

		if (token.startsWith('-')) {
			const valueType = shortTypes.get(token);
			if (valueType == null) {
				throw new Error(`Unknown flag '${token}'. Run with --help to see valid options.`);
			}

			if (valueType !== 'boolean') {
				const nextToken = args[index + 1];
				if (nextToken == null || nextToken.startsWith('-')) {
					throw new Error(`Flag '${token}' requires a value.`);
				}
				index += 1;
			}

			continue;
		}

		throw new Error(`Unexpected argument '${token}'. Use --help to see valid options and flags.`);
	}
}

function normalizeBareBreakdownFlag(args: string[]): string[] {
	const normalized: string[] = [];

	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (token == null) {
			continue;
		}

		if (token === '--') {
			normalized.push(token, ...args.slice(index + 1));
			break;
		}

		if (token === '--breakdown') {
			const nextToken = args[index + 1];
			if (nextToken == null || nextToken.startsWith('-')) {
				normalized.push(`--breakdown=${DEFAULT_BREAKDOWN_VALUE}`);
				continue;
			}
		}

		normalized.push(token);
	}

	return normalized;
}

export async function run(): Promise<void> {
	// When invoked through npx, the binary name might be passed as the first argument
	// Filter it out if it matches the expected binary name
	let args = process.argv.slice(2);
	if (args[0] === 'ccusage-opencode') {
		args = args.slice(1);
	}

	args = normalizeBareBreakdownFlag(args);

	const subCommandName = args[0];
	if (typeof subCommandName === 'string') {
		const subCommand = subCommands.get(subCommandName);
		if (subCommand != null) {
			assertNoUnknownFlags(subCommand as CommandLike, args.slice(1));
		} else {
			assertNoUnknownFlags(mainCommand as CommandLike, args);
		}
	}

	await cli(args, mainCommand, {
		name,
		version,
		description,
		subCommands,
		renderHeader: null,
	});
}
