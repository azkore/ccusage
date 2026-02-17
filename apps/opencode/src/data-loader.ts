/**
 * @fileoverview Data loading utilities for OpenCode usage analysis.
 *
 * OpenCode >= 1.2 stores session/message data in SQLite at:
 * ~/.local/share/opencode/opencode.db
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { isDirectorySync } from 'path-type';
import { logger } from './logger.ts';

const DEFAULT_OPENCODE_PATH = '.local/share/opencode';
const OPENCODE_CONFIG_DIR_ENV = 'OPENCODE_DATA_DIR';
const OPENCODE_DB_FILENAME = 'opencode.db';
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

export type LoadedSessionMetadata = {
	id: string;
	parentID: string | null;
	title: string;
	projectID: string;
	directory: string;
};

type MessageRow = {
	session_id: string;
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
