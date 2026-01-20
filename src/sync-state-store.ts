import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { SyncState } from "./sync-state.js";
import type { Logger } from "./logger.js";

type PlainObject = Record<string, unknown>;

export interface SyncStateLoadOptions {
  boardId?: string;
  prdPath?: string;
  mappingSignature?: string;
  warn?: (message: string) => void;
  logger?: Logger;
}

const isPlainObject = (value: unknown): value is PlainObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requireString = (value: unknown, label: string): string => {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string`);
  }
  return value;
};

const requirePlainObject = (value: unknown, label: string): PlainObject => {
  if (!isPlainObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
};

const parseStoryIndex = (value: unknown): SyncState["storyIndex"] => {
  const root = requirePlainObject(value, "state.storyIndex");
  const parsed: SyncState["storyIndex"] = {};
  Object.entries(root).forEach(([id, entry]) => {
    const item = requirePlainObject(entry, `state.storyIndex.${id}`);
    parsed[id] = {
      fingerprint: requireString(item.fingerprint, `state.storyIndex.${id}.fingerprint`),
    };
  });
  return parsed;
};

const parseCardIndex = (value: unknown): SyncState["cardIndex"] => {
  const root = requirePlainObject(value, "state.cardIndex");
  const parsed: SyncState["cardIndex"] = {};
  Object.entries(root).forEach(([id, entry]) => {
    const item = requirePlainObject(entry, `state.cardIndex.${id}`);
    parsed[id] = {
      cardId: requireString(item.cardId, `state.cardIndex.${id}.cardId`),
      lastActivityAt: requireString(
        item.lastActivityAt,
        `state.cardIndex.${id}.lastActivityAt`,
      ),
    };
  });
  return parsed;
};

const parseSyncState = (value: unknown): SyncState => {
  const root = requirePlainObject(value, "state");
  const version = root.version;
  if (version !== 1) {
    throw new Error("state.version must be 1");
  }
  return {
    version: 1,
    lastRunAt: requireString(root.lastRunAt, "state.lastRunAt"),
    boardId: requireString(root.boardId, "state.boardId"),
    prdPath: requireString(root.prdPath, "state.prdPath"),
    mappingSignature: requireString(
      root.mappingSignature,
      "state.mappingSignature",
    ),
    lastSeenTrelloActivity: requireString(
      root.lastSeenTrelloActivity,
      "state.lastSeenTrelloActivity",
    ),
    storyIndex: parseStoryIndex(root.storyIndex),
    cardIndex: parseCardIndex(root.cardIndex),
  };
};

const validateSyncState = (
  state: SyncState,
  options: SyncStateLoadOptions,
): void => {
  if (options.boardId && state.boardId !== options.boardId) {
    throw new Error(
      `state.boardId mismatch (expected '${options.boardId}', got '${state.boardId}')`,
    );
  }
  if (options.prdPath && state.prdPath !== options.prdPath) {
    throw new Error(
      `state.prdPath mismatch (expected '${options.prdPath}', got '${state.prdPath}')`,
    );
  }
  if (
    options.mappingSignature &&
    state.mappingSignature !== options.mappingSignature
  ) {
    throw new Error("state.mappingSignature mismatch (mapping changed)");
  }
};

const warnDefault = (message: string): void => {
  console.warn(message);
};

const warnWithOptions = (
  options: SyncStateLoadOptions,
  message: string,
  data?: Record<string, unknown>,
): void => {
  if (options.warn) {
    options.warn(message);
    return;
  }
  if (options.logger) {
    options.logger.warn(message, data);
    return;
  }
  warnDefault(message);
};

export const loadSyncState = async (
  statePath: string,
  options: SyncStateLoadOptions = {},
): Promise<SyncState | null> => {
  let raw: string;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    const maybeError = error as NodeJS.ErrnoException | null;
    if (maybeError?.code === "ENOENT") {
      return null;
    }
    const message =
      maybeError instanceof Error ? maybeError.message : "Unknown file system error";
    warnWithOptions(
      options,
      `Ignoring sync state at ${statePath}: failed to read (${message})`,
      { statePath, error: message, reason: "read_failed" },
    );
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown JSON error";
    warnWithOptions(
      options,
      `Ignoring sync state at ${statePath}: invalid JSON (${message})`,
      { statePath, error: message, reason: "invalid_json" },
    );
    return null;
  }

  try {
    const state = parseSyncState(parsed);
    validateSyncState(state, options);
    return state;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown validation error";
    warnWithOptions(
      options,
      `Ignoring sync state at ${statePath}: ${message}`,
      { statePath, error: message, reason: "validation_error" },
    );
    return null;
  }
};

export const saveSyncState = async (
  statePath: string,
  state: SyncState,
): Promise<void> => {
  await mkdir(path.dirname(statePath), { recursive: true });
  const serialized = `${JSON.stringify(state, null, 2)}\n`;
  await writeFile(statePath, serialized, "utf8");
};
