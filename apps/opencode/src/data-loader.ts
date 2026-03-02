/**
 * @fileoverview Data loading utilities for OpenCode usage analysis.
 *
 * OpenCode >= 1.2 stores session/message data in SQLite at:
 * ~/.local/share/opencode/opencode.db
 */

import { createReadStream, existsSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { createInterface } from 'node:readline';
import { isDirectorySync } from 'path-type';
import { glob } from 'tinyglobby';
import { logger } from './logger.ts';

const DEFAULT_OPENCODE_PATH = '.local/share/opencode';
const OPENCODE_CONFIG_DIR_ENV = 'OPENCODE_DATA_DIR';
const OPENCODE_DB_FILENAME = 'opencode.db';
const CLAUDE_CONFIG_DIR_ENV = 'CLAUDE_CONFIG_DIR';
const CLAUDE_PROJECTS_DIR_NAME = 'projects';
const DEFAULT_CLAUDE_CONFIG_PATH = '.config/claude';
const DEFAULT_CLAUDE_CODE_PATH = '.claude';
const CODEX_HOME_ENV = 'CODEX_HOME';
const DEFAULT_CODEX_DIR = '.codex';
const CODEX_SESSION_SUBDIR = 'sessions';
const CODEX_SESSION_GLOB = '**/*.jsonl';
const USER_HOME_DIR = process.env.HOME ?? process.env.USERPROFILE ?? process.cwd();
const require = createRequire(import.meta.url);

let databaseSyncCtor:
	| (new (
			path: string,
			options: { readOnly: boolean },
	  ) => {
			prepare: (sql: string) => { all: () => unknown[] };
			close: () => void;
	  })
	| null = null;
let sqliteWarningSuppressed = false;

function ensureSQLiteWarningSuppressed(): void {
	if (sqliteWarningSuppressed) {
		return;
	}

	const originalEmitWarning = process.emitWarning.bind(process);
	process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
		if (typeof warning === 'string') {
			if (warning.includes('SQLite is an experimental feature')) {
				return;
			}
		} else if (warning.name === 'ExperimentalWarning' && warning.message.includes('SQLite')) {
			return;
		}

		return (originalEmitWarning as (...args: unknown[]) => void)(warning, ...args);
	}) as typeof process.emitWarning;

	sqliteWarningSuppressed = true;
}

function getDatabaseSyncCtor() {
	if (databaseSyncCtor != null) {
		return databaseSyncCtor;
	}

	ensureSQLiteWarningSuppressed();
	const sqlite = require('node:sqlite') as {
		DatabaseSync: new (
			path: string,
			options: { readOnly: boolean },
		) => {
			prepare: (sql: string) => { all: () => unknown[] };
			close: () => void;
		};
	};
	databaseSyncCtor = sqlite.DatabaseSync;
	return databaseSyncCtor;
}

export type LoadedUsageEntry = {
	timestamp: Date;
	sessionID: string;
	source: Exclude<UsageSource, 'all'>;
	provider: string;
	usage: {
		inputTokens: number;
		outputTokens: number;
		reasoningTokens: number;
		cacheCreationInputTokens: number;
		cacheReadInputTokens: number;
	};
	model: string;
	costUSD: number | null;
};

export type UsageSource = 'opencode' | 'claude' | 'codex' | 'all';

export type LoadedSessionMetadata = {
	id: string;
	parentID: string | null;
	title: string;
	projectID: string;
	directory: string;
};

type MessageRow = {
	session_id: string;
	providerID: string | null;
	modelID: string | null;
	input: number | null;
	output: number | null;
	reasoning: number | null;
	cache_read: number | null;
	cache_write: number | null;
	cost: number | null;
	time_created: number | null;
};

type SessionRow = {
	id: string;
	parent_id: string | null;
	title: string | null;
	project_id: string | null;
	directory: string | null;
};

type ClaudeUsagePayload = {
	input_tokens?: unknown;
	output_tokens?: unknown;
	cache_creation_input_tokens?: unknown;
	cache_read_input_tokens?: unknown;
	reasoning_tokens?: unknown;
};

type ClaudeMessagePayload = {
	usage?: ClaudeUsagePayload;
	model?: unknown;
};

type ClaudeLinePayload = {
	timestamp?: unknown;
	sessionId?: unknown;
	message?: ClaudeMessagePayload;
	costUSD?: unknown;
};

export function getOpenCodePath(): string | null {
	const envPath = process.env[OPENCODE_CONFIG_DIR_ENV];
	if (envPath != null && envPath.trim() !== '') {
		const normalizedPath = path.resolve(envPath);
		if (isDirectorySync(normalizedPath)) {
			return normalizedPath;
		}
	}

	const defaultPath = path.join(USER_HOME_DIR, DEFAULT_OPENCODE_PATH);
	if (isDirectorySync(defaultPath)) {
		return defaultPath;
	}

	return null;
}

export function parseUsageSource(value: string | undefined): UsageSource {
	const normalized = value?.trim().toLowerCase() ?? 'all';
	if (normalized === '' || normalized === 'all') {
		return 'all';
	}
	if (normalized === 'opencode') {
		return 'opencode';
	}
	if (normalized === 'claude') {
		return 'claude';
	}
	if (normalized === 'codex') {
		return 'codex';
	}

	throw new Error("Invalid --source value. Use 'opencode', 'claude', 'codex', or 'all'.");
}

function getClaudePaths(): string[] {
	const envPaths = (process.env[CLAUDE_CONFIG_DIR_ENV] ?? '').trim();
	if (envPaths !== '') {
		const configured = envPaths
			.split(',')
			.map((p) => p.trim())
			.filter((p) => p !== '')
			.map((p) => path.resolve(p))
			.filter((p) => isDirectorySync(path.join(p, CLAUDE_PROJECTS_DIR_NAME)));

		return Array.from(new Set(configured));
	}

	const defaults = [
		path.join(USER_HOME_DIR, DEFAULT_CLAUDE_CONFIG_PATH),
		path.join(USER_HOME_DIR, DEFAULT_CLAUDE_CODE_PATH),
	];

	return defaults.filter((basePath) =>
		isDirectorySync(path.join(basePath, CLAUDE_PROJECTS_DIR_NAME)),
	);
}

function getOpenCodeDbPath(): string | null {
	const openCodePath = getOpenCodePath();
	if (openCodePath == null) {
		return null;
	}

	const dbPath = path.join(openCodePath, OPENCODE_DB_FILENAME);
	return existsSync(dbPath) ? dbPath : null;
}

export async function loadOpenCodeSessions(): Promise<Map<string, LoadedSessionMetadata>> {
	const dbPath = getOpenCodeDbPath();
	if (dbPath == null) {
		return new Map();
	}

	const DatabaseSync = getDatabaseSyncCtor();
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const rows = db
			.prepare('SELECT id, parent_id, title, project_id, directory FROM session')
			.all() as SessionRow[];
		const sessionMap = new Map<string, LoadedSessionMetadata>();

		for (const row of rows) {
			sessionMap.set(row.id, {
				id: row.id,
				parentID: row.parent_id,
				title: row.title != null && row.title !== '' ? row.title : row.id,
				projectID: row.project_id != null && row.project_id !== '' ? row.project_id : 'unknown',
				directory: row.directory != null && row.directory !== '' ? row.directory : 'unknown',
			});
		}

		return sessionMap;
	} catch (error) {
		logger.warn('Failed to load sessions from OpenCode SQLite', error);
		return new Map();
	} finally {
		db.close();
	}
}

export async function loadOpenCodeMessages(): Promise<LoadedUsageEntry[]> {
	const dbPath = getOpenCodeDbPath();
	if (dbPath == null) {
		return [];
	}

	const DatabaseSync = getDatabaseSyncCtor();
	const db = new DatabaseSync(dbPath, { readOnly: true });
	try {
		const rows = db
			.prepare(
				`SELECT
					session_id,
					json_extract(data, '$.providerID') as providerID,
					json_extract(data, '$.modelID') as modelID,
					json_extract(data, '$.tokens.input') as input,
					json_extract(data, '$.tokens.output') as output,
					json_extract(data, '$.tokens.reasoning') as reasoning,
					json_extract(data, '$.tokens.cache.read') as cache_read,
					json_extract(data, '$.tokens.cache.write') as cache_write,
					json_extract(data, '$.cost') as cost,
					json_extract(data, '$.time.created') as time_created
				FROM message
				WHERE json_extract(data, '$.role') = 'assistant'
					AND json_extract(data, '$.providerID') IS NOT NULL
					AND json_extract(data, '$.modelID') IS NOT NULL`,
			)
			.all() as MessageRow[];

		const entries: LoadedUsageEntry[] = [];
		for (const row of rows) {
			const inputTokens = row.input ?? 0;
			const outputTokens = row.output ?? 0;
			const reasoningTokens = row.reasoning ?? 0;
			if (inputTokens === 0 && outputTokens === 0 && reasoningTokens === 0) {
				continue;
			}

			entries.push({
				timestamp: new Date(row.time_created ?? Date.now()),
				sessionID: row.session_id,
				source: 'opencode',
				provider: row.providerID ?? 'unknown',
				usage: {
					inputTokens,
					outputTokens,
					reasoningTokens,
					cacheCreationInputTokens: row.cache_write ?? 0,
					cacheReadInputTokens: row.cache_read ?? 0,
				},
				model: row.modelID ?? 'unknown',
				costUSD: row.cost,
			});
		}

		return entries;
	} catch (error) {
		logger.warn('Failed to load messages from OpenCode SQLite', error);
		return [];
	} finally {
		db.close();
	}
}

function asNumber(value: unknown): number {
	if (typeof value !== 'number' || Number.isNaN(value)) {
		return 0;
	}

	return value;
}

function inferProviderFromModel(model: string): string {
	const slashIndex = model.indexOf('/');
	if (slashIndex > 0) {
		return model.slice(0, slashIndex).toLowerCase();
	}

	if (model.startsWith('claude-')) {
		return 'anthropic';
	}
	if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')) {
		return 'openai';
	}
	if (model.startsWith('gemini-')) {
		return 'google';
	}

	return 'unknown';
}

async function loadClaudeData(): Promise<{
	entries: LoadedUsageEntry[];
	sessionMetadataMap: Map<string, LoadedSessionMetadata>;
}> {
	const claudePaths = getClaudePaths();
	if (claudePaths.length === 0) {
		return { entries: [], sessionMetadataMap: new Map() };
	}

	const filesByProjectsDir = await Promise.all(
		claudePaths.map(async (claudePath) => {
			const projectsDir = path.join(claudePath, CLAUDE_PROJECTS_DIR_NAME);
			const files = await glob('**/*.jsonl', {
				cwd: projectsDir,
				absolute: true,
			}).catch(() => []);

			return { projectsDir, files };
		}),
	);

	const entries: LoadedUsageEntry[] = [];
	const sessionMetadataMap = new Map<string, LoadedSessionMetadata>();

	for (const { projectsDir, files } of filesByProjectsDir) {
		for (const filePath of files) {
			const relativePath = path.relative(projectsDir, filePath);
			const segments = relativePath.split(path.sep);
			const projectName = segments[0] != null && segments[0] !== '' ? segments[0] : 'unknown';
			const fileSessionID = path.basename(filePath, '.jsonl');

			const fileStream = createReadStream(filePath, { encoding: 'utf-8' });
			const lineReader = createInterface({
				input: fileStream,
				crlfDelay: Number.POSITIVE_INFINITY,
			});

			for await (const line of lineReader) {
				const trimmed = line.trim();
				if (trimmed === '') {
					continue;
				}

				try {
					const parsed = JSON.parse(trimmed) as ClaudeLinePayload;
					const usage = parsed.message?.usage;
					if (usage == null) {
						continue;
					}

					const inputTokens = asNumber(usage.input_tokens);
					const outputTokens = asNumber(usage.output_tokens);
					const cacheCreationInputTokens = asNumber(usage.cache_creation_input_tokens);
					const cacheReadInputTokens = asNumber(usage.cache_read_input_tokens);
					const reasoningTokens = asNumber(usage.reasoning_tokens);

					if (
						inputTokens === 0 &&
						outputTokens === 0 &&
						cacheCreationInputTokens === 0 &&
						cacheReadInputTokens === 0 &&
						reasoningTokens === 0
					) {
						continue;
					}

					const timestampValue = parsed.timestamp;
					const timestamp =
						typeof timestampValue === 'string' || typeof timestampValue === 'number'
							? new Date(timestampValue)
							: null;
					if (timestamp == null || Number.isNaN(timestamp.getTime())) {
						continue;
					}

					const sessionID =
						typeof parsed.sessionId === 'string' && parsed.sessionId.trim() !== ''
							? parsed.sessionId
							: fileSessionID;
					const model =
						typeof parsed.message?.model === 'string' && parsed.message.model.trim() !== ''
							? parsed.message.model
							: 'unknown';
					const provider = inferProviderFromModel(model);

					if (!sessionMetadataMap.has(sessionID)) {
						sessionMetadataMap.set(sessionID, {
							id: sessionID,
							parentID: null,
							title: sessionID,
							projectID: projectName,
							directory: projectName,
						});
					}

					entries.push({
						timestamp,
						sessionID,
						source: 'claude',
						provider,
						usage: {
							inputTokens,
							outputTokens,
							reasoningTokens,
							cacheCreationInputTokens,
							cacheReadInputTokens,
						},
						model,
						costUSD: typeof parsed.costUSD === 'number' ? parsed.costUSD : null,
					});
				} catch {
					continue;
				}
			}
		}
	}

	return {
		entries,
		sessionMetadataMap,
	};
}

// ---------------------------------------------------------------------------
// Codex loader — ported from apps/codex/src/data-loader.ts
// ---------------------------------------------------------------------------

type CodexRawUsage = {
	input_tokens: number;
	cached_input_tokens: number;
	output_tokens: number;
	reasoning_output_tokens: number;
	total_tokens: number;
};

function codexEnsureNumber(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function normalizeCodexRawUsage(value: unknown): CodexRawUsage | null {
	if (value == null || typeof value !== 'object') {
		return null;
	}

	const record = value as Record<string, unknown>;
	const input = codexEnsureNumber(record.input_tokens);
	const cached = codexEnsureNumber(record.cached_input_tokens ?? record.cache_read_input_tokens);
	const output = codexEnsureNumber(record.output_tokens);
	const reasoning = codexEnsureNumber(record.reasoning_output_tokens);
	const total = codexEnsureNumber(record.total_tokens);

	return {
		input_tokens: input,
		cached_input_tokens: cached,
		output_tokens: output,
		reasoning_output_tokens: reasoning,
		total_tokens: total > 0 ? total : input + output,
	};
}

function subtractCodexRawUsage(
	current: CodexRawUsage,
	previous: CodexRawUsage | null,
): CodexRawUsage {
	return {
		input_tokens: Math.max(current.input_tokens - (previous?.input_tokens ?? 0), 0),
		cached_input_tokens: Math.max(
			current.cached_input_tokens - (previous?.cached_input_tokens ?? 0),
			0,
		),
		output_tokens: Math.max(current.output_tokens - (previous?.output_tokens ?? 0), 0),
		reasoning_output_tokens: Math.max(
			current.reasoning_output_tokens - (previous?.reasoning_output_tokens ?? 0),
			0,
		),
		total_tokens: Math.max(current.total_tokens - (previous?.total_tokens ?? 0), 0),
	};
}

function codexAsNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== 'string') {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed === '' ? undefined : trimmed;
}

function extractCodexModel(payload: Record<string, unknown>): string | undefined {
	const info = payload.info;
	if (info != null && typeof info === 'object') {
		const infoRecord = info as Record<string, unknown>;
		for (const key of ['model', 'model_name']) {
			const model = codexAsNonEmptyString(infoRecord[key]);
			if (model != null) {
				return model;
			}
		}

		const metadata = infoRecord.metadata;
		if (metadata != null && typeof metadata === 'object') {
			const model = codexAsNonEmptyString((metadata as Record<string, unknown>).model);
			if (model != null) {
				return model;
			}
		}
	}

	const fallbackModel = codexAsNonEmptyString(payload.model);
	if (fallbackModel != null) {
		return fallbackModel;
	}

	const metadata = payload.metadata;
	if (metadata != null && typeof metadata === 'object') {
		const model = codexAsNonEmptyString((metadata as Record<string, unknown>).model);
		if (model != null) {
			return model;
		}
	}

	return undefined;
}

function getCodexSessionDir(): string | null {
	const envPath = (process.env[CODEX_HOME_ENV] ?? '').trim();
	const codexHome =
		envPath !== '' ? path.resolve(envPath) : path.join(USER_HOME_DIR, DEFAULT_CODEX_DIR);
	const sessionsDir = path.join(codexHome, CODEX_SESSION_SUBDIR);

	return isDirectorySync(sessionsDir) ? sessionsDir : null;
}

const CODEX_LEGACY_FALLBACK_MODEL = 'gpt-5';

async function loadCodexData(): Promise<{
	entries: LoadedUsageEntry[];
	sessionMetadataMap: Map<string, LoadedSessionMetadata>;
}> {
	const sessionDir = getCodexSessionDir();
	if (sessionDir == null) {
		return { entries: [], sessionMetadataMap: new Map() };
	}

	const entries: LoadedUsageEntry[] = [];
	const sessionMetadataMap = new Map<string, LoadedSessionMetadata>();

	const files = await glob(CODEX_SESSION_GLOB, {
		cwd: sessionDir,
		absolute: true,
	}).catch(() => [] as string[]);

	for (const filePath of files) {
		const relPath = path.relative(sessionDir, filePath);
		const sessionId = relPath
			.split(path.sep)
			.join('/')
			.replace(/\.jsonl$/i, '');

		let fileContent: string;
		try {
			fileContent = await readFileAsync(filePath, 'utf-8');
		} catch {
			continue;
		}

		let previousTotals: CodexRawUsage | null = null;
		let currentModel: string | undefined;
		let currentModelIsFallback = false;
		const lines = fileContent.split(/\r?\n/);

		for (const line of lines) {
			const trimmed = line.trim();
			if (trimmed === '') {
				continue;
			}

			let parsed: Record<string, unknown>;
			try {
				parsed = JSON.parse(trimmed) as Record<string, unknown>;
			} catch {
				continue;
			}

			const entryType = parsed.type;
			const payload = parsed.payload as Record<string, unknown> | undefined;
			const timestamp = parsed.timestamp;

			if (typeof entryType !== 'string') {
				continue;
			}

			// Extract model from turn_context entries
			if (entryType === 'turn_context' && payload != null) {
				const contextModel = extractCodexModel(payload);
				if (contextModel != null) {
					currentModel = contextModel;
					currentModelIsFallback = false;
				}
				continue;
			}

			if (entryType !== 'event_msg') {
				continue;
			}

			if (payload == null || payload.type !== 'token_count') {
				continue;
			}

			if (typeof timestamp !== 'string') {
				continue;
			}

			const info = payload.info as Record<string, unknown> | undefined;
			const lastUsage = normalizeCodexRawUsage(info?.last_token_usage);
			const totalUsage = normalizeCodexRawUsage(info?.total_token_usage);

			let raw = lastUsage;
			if (raw == null && totalUsage != null) {
				raw = subtractCodexRawUsage(totalUsage, previousTotals);
			}

			if (totalUsage != null) {
				previousTotals = totalUsage;
			}

			if (raw == null) {
				continue;
			}

			const cachedInput = Math.min(raw.cached_input_tokens, raw.input_tokens);

			if (
				raw.input_tokens === 0 &&
				cachedInput === 0 &&
				raw.output_tokens === 0 &&
				raw.reasoning_output_tokens === 0
			) {
				continue;
			}

			const extractionSource = Object.assign({}, payload, { info });
			const extractedModel = extractCodexModel(extractionSource);
			if (extractedModel != null) {
				currentModel = extractedModel;
				currentModelIsFallback = false;
			}

			let model = extractedModel ?? currentModel;
			if (model == null) {
				model = CODEX_LEGACY_FALLBACK_MODEL;
				currentModel = model;
				currentModelIsFallback = true;
			} else if (extractedModel == null && currentModelIsFallback) {
				// still using fallback
			}

			const parsedTimestamp = new Date(timestamp);
			if (Number.isNaN(parsedTimestamp.getTime())) {
				continue;
			}

			if (!sessionMetadataMap.has(sessionId)) {
				sessionMetadataMap.set(sessionId, {
					id: sessionId,
					parentID: null,
					title: sessionId,
					projectID: 'codex',
					directory: path.dirname(relPath),
				});
			}

			entries.push({
				timestamp: parsedTimestamp,
				sessionID: sessionId,
				source: 'codex',
				provider: inferProviderFromModel(model),
				usage: {
					inputTokens: raw.input_tokens - cachedInput,
					outputTokens: raw.output_tokens,
					reasoningTokens: raw.reasoning_output_tokens,
					cacheCreationInputTokens: 0,
					cacheReadInputTokens: cachedInput,
				},
				model,
				costUSD: null,
			});
		}
	}

	return { entries, sessionMetadataMap };
}

function mergeSessionMetadataMaps(
	...maps: Array<Map<string, LoadedSessionMetadata>>
): Map<string, LoadedSessionMetadata> {
	const merged = new Map<string, LoadedSessionMetadata>();
	for (const map of maps) {
		for (const [sessionID, metadata] of map.entries()) {
			if (!merged.has(sessionID)) {
				merged.set(sessionID, metadata);
			}
		}
	}

	return merged;
}

export async function loadUsageData(source: UsageSource): Promise<{
	entries: LoadedUsageEntry[];
	sessionMetadataMap: Map<string, LoadedSessionMetadata>;
}> {
	if (source === 'opencode') {
		const [entries, sessionMetadataMap] = await Promise.all([
			loadOpenCodeMessages(),
			loadOpenCodeSessions(),
		]);
		return { entries, sessionMetadataMap };
	}

	if (source === 'claude') {
		return loadClaudeData();
	}

	if (source === 'codex') {
		return loadCodexData();
	}

	const [openCodeEntries, openCodeSessions, claudeData, codexData] = await Promise.all([
		loadOpenCodeMessages(),
		loadOpenCodeSessions(),
		loadClaudeData(),
		loadCodexData(),
	]);

	return {
		entries: [...openCodeEntries, ...claudeData.entries, ...codexData.entries],
		sessionMetadataMap: mergeSessionMetadataMaps(
			openCodeSessions,
			claudeData.sessionMetadataMap,
			codexData.sessionMetadataMap,
		),
	};
}
