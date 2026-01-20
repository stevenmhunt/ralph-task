import { readFile } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_CONFIG_PATH = ".ralphtask.json";

export type SyncDirection = "two-way" | "trello-to-prd" | "prd-to-trello";
export type ConflictStrategy = "last-write-wins";
export type ConflictPrefer = "none" | "trello" | "prd";
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";
export type LogFormat = "text" | "json";

export interface RalphtaskConfig {
  version: number;
  paths: {
    prdFile: string;
    stateFile: string;
  };
  trello: {
    apiKey: string;
    token: string;
    boardId: string;
  };
  mapping: {
    storyPrefix: string;
    idPattern: string;
    cardTitleFormat: string;
    dependsOnLabelPrefix: string;
    statusToList: {
      open: string;
      in_progress: string;
      done: string;
    };
    acceptanceCriteriaChecklistName: string;
  };
  sync: {
    direction: SyncDirection;
    incremental: boolean;
    dryRun: boolean;
    maxConcurrency: number;
    retry: {
      maxRetries: number;
      baseDelayMs: number;
    };
  };
  conflict: {
    strategy: ConflictStrategy;
    defaultPrefer: ConflictPrefer;
    blockWrites: boolean;
    createMissingLabels: boolean;
  };
  logging: {
    level: LogLevel;
    format: LogFormat;
  };
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

type PlainObject = Record<string, unknown>;

const DEFAULTS = {
  version: 1,
  paths: {
    stateFile: ".ralph-task/state.json",
  },
  mapping: {
    storyPrefix: "US",
    idPattern: "{prefix}-{number:3}",
    cardTitleFormat: "[{id}] {title}",
    dependsOnLabelPrefix: "",
    statusToList: {
      open: "To Do",
      in_progress: "In Progress",
      done: "Done",
    },
    acceptanceCriteriaChecklistName: "Acceptance Criteria",
  },
  sync: {
    direction: "two-way" as SyncDirection,
    incremental: true,
    dryRun: false,
    maxConcurrency: 4,
    retry: {
      maxRetries: 5,
      baseDelayMs: 500,
    },
  },
  conflict: {
    strategy: "last-write-wins" as ConflictStrategy,
    defaultPrefer: "none" as ConflictPrefer,
    blockWrites: false,
    createMissingLabels: true,
  },
  logging: {
    level: "info" as LogLevel,
    format: "text" as LogFormat,
  },
};

const VALID_DIRECTIONS: SyncDirection[] = [
  "two-way",
  "trello-to-prd",
  "prd-to-trello",
];
const VALID_CONFLICT_STRATEGIES: ConflictStrategy[] = ["last-write-wins"];
const VALID_CONFLICT_PREFERS: ConflictPrefer[] = ["none", "trello", "prd"];
const VALID_LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error", "silent"];
const VALID_LOG_FORMATS: LogFormat[] = ["text", "json"];

const isPlainObject = (value: unknown): value is PlainObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const requireObject = (value: unknown, label: string): PlainObject => {
  if (!isPlainObject(value)) {
    throw new ConfigError(`${label} must be an object`);
  }
  return value;
};

const optionalObject = (value: unknown, label: string): PlainObject => {
  if (value === undefined) {
    return {};
  }
  if (!isPlainObject(value)) {
    throw new ConfigError(`${label} must be an object`);
  }
  return value;
};

const requireNonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`Missing required ${label}`);
  }
  return value;
};

const optionalString = (
  value: unknown,
  label: string,
  fallback: string,
): string => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new ConfigError(`${label} must be a string`);
  }
  return value;
};

const optionalBoolean = (
  value: unknown,
  label: string,
  fallback: boolean,
): boolean => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new ConfigError(`${label} must be a boolean`);
  }
  return value;
};

const optionalInteger = (
  value: unknown,
  label: string,
  fallback: number,
  minValue: number,
): number => {
  if (value === undefined) {
    return fallback;
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minValue
  ) {
    throw new ConfigError(
      `${label} must be an integer greater than or equal to ${minValue}`,
    );
  }
  return value;
};

const optionalEnum = <T extends string>(
  value: unknown,
  label: string,
  fallback: T,
  allowed: readonly T[],
): T => {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "string") {
    throw new ConfigError(`${label} must be a string`);
  }
  if (!allowed.includes(value as T)) {
    throw new ConfigError(
      `${label} must be one of: ${allowed.map((item) => `'${item}'`).join(", ")}`,
    );
  }
  return value as T;
};

const normalizeConfig = (input: unknown): RalphtaskConfig => {
  const root = requireObject(input, "Config");

  const version = optionalInteger(root.version, "version", DEFAULTS.version, 1);

  const pathsInput = requireObject(root.paths, "paths");
  const prdFile = requireNonEmptyString(pathsInput.prdFile, "paths.prdFile");
  const stateFile = optionalString(
    pathsInput.stateFile,
    "paths.stateFile",
    DEFAULTS.paths.stateFile,
  );

  const trelloInput = requireObject(root.trello, "trello");
  const apiKey = trelloInput.apiKey;
  const token = trelloInput.token;
  const missingCredentials: string[] = [];
  if (typeof apiKey !== "string" || apiKey.trim() === "") {
    missingCredentials.push("apiKey");
  }
  if (typeof token !== "string" || token.trim() === "") {
    missingCredentials.push("token");
  }
  if (missingCredentials.length > 0) {
    throw new ConfigError(
      `Missing required Trello credentials: ${missingCredentials.join(", ")}`,
    );
  }
  const boardId = requireNonEmptyString(trelloInput.boardId, "trello.boardId");

  const mappingInput = optionalObject(root.mapping, "mapping");
  const statusToListInput = optionalObject(
    mappingInput.statusToList,
    "mapping.statusToList",
  );
  const mapping = {
    storyPrefix: optionalString(
      mappingInput.storyPrefix,
      "mapping.storyPrefix",
      DEFAULTS.mapping.storyPrefix,
    ),
    idPattern: optionalString(
      mappingInput.idPattern,
      "mapping.idPattern",
      DEFAULTS.mapping.idPattern,
    ),
    cardTitleFormat: optionalString(
      mappingInput.cardTitleFormat,
      "mapping.cardTitleFormat",
      DEFAULTS.mapping.cardTitleFormat,
    ),
    dependsOnLabelPrefix: optionalString(
      mappingInput.dependsOnLabelPrefix,
      "mapping.dependsOnLabelPrefix",
      DEFAULTS.mapping.dependsOnLabelPrefix,
    ),
    statusToList: {
      open: optionalString(
        statusToListInput.open,
        "mapping.statusToList.open",
        DEFAULTS.mapping.statusToList.open,
      ),
      in_progress: optionalString(
        statusToListInput.in_progress,
        "mapping.statusToList.in_progress",
        DEFAULTS.mapping.statusToList.in_progress,
      ),
      done: optionalString(
        statusToListInput.done,
        "mapping.statusToList.done",
        DEFAULTS.mapping.statusToList.done,
      ),
    },
    acceptanceCriteriaChecklistName: optionalString(
      mappingInput.acceptanceCriteriaChecklistName,
      "mapping.acceptanceCriteriaChecklistName",
      DEFAULTS.mapping.acceptanceCriteriaChecklistName,
    ),
  };

  const syncInput = optionalObject(root.sync, "sync");
  const retryInput = optionalObject(syncInput.retry, "sync.retry");
  const sync = {
    direction: optionalEnum(
      syncInput.direction,
      "sync.direction",
      DEFAULTS.sync.direction,
      VALID_DIRECTIONS,
    ),
    incremental: optionalBoolean(
      syncInput.incremental,
      "sync.incremental",
      DEFAULTS.sync.incremental,
    ),
    dryRun: optionalBoolean(syncInput.dryRun, "sync.dryRun", DEFAULTS.sync.dryRun),
    maxConcurrency: optionalInteger(
      syncInput.maxConcurrency,
      "sync.maxConcurrency",
      DEFAULTS.sync.maxConcurrency,
      1,
    ),
    retry: {
      maxRetries: optionalInteger(
        retryInput.maxRetries,
        "sync.retry.maxRetries",
        DEFAULTS.sync.retry.maxRetries,
        0,
      ),
      baseDelayMs: optionalInteger(
        retryInput.baseDelayMs,
        "sync.retry.baseDelayMs",
        DEFAULTS.sync.retry.baseDelayMs,
        0,
      ),
    },
  };

  const conflictInput = optionalObject(root.conflict, "conflict");
  const conflict = {
    strategy: optionalEnum(
      conflictInput.strategy,
      "conflict.strategy",
      DEFAULTS.conflict.strategy,
      VALID_CONFLICT_STRATEGIES,
    ),
    defaultPrefer: optionalEnum(
      conflictInput.defaultPrefer,
      "conflict.defaultPrefer",
      DEFAULTS.conflict.defaultPrefer,
      VALID_CONFLICT_PREFERS,
    ),
    blockWrites: optionalBoolean(
      conflictInput.blockWrites,
      "conflict.blockWrites",
      DEFAULTS.conflict.blockWrites,
    ),
    createMissingLabels: optionalBoolean(
      conflictInput.createMissingLabels,
      "conflict.createMissingLabels",
      DEFAULTS.conflict.createMissingLabels,
    ),
  };

  const loggingInput = optionalObject(root.logging, "logging");
  const logging = {
    level: optionalEnum(
      loggingInput.level,
      "logging.level",
      DEFAULTS.logging.level,
      VALID_LOG_LEVELS,
    ),
    format: optionalEnum(
      loggingInput.format,
      "logging.format",
      DEFAULTS.logging.format,
      VALID_LOG_FORMATS,
    ),
  };

  return {
    version,
    paths: {
      prdFile,
      stateFile,
    },
    trello: {
      apiKey: apiKey as string,
      token: token as string,
      boardId,
    },
    mapping,
    sync,
    conflict,
    logging,
  };
};

const resolveConfigPath = (configPath: string | undefined, cwd: string): string => {
  const targetPath = configPath ?? DEFAULT_CONFIG_PATH;
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(cwd, targetPath);
};

export const loadRalphtaskConfig = async (
  configPath?: string,
  options?: { cwd?: string },
): Promise<RalphtaskConfig> => {
  const cwd = options?.cwd ?? process.cwd();
  const resolvedPath = resolveConfigPath(configPath, cwd);
  let rawConfig: string;
  try {
    rawConfig = await readFile(resolvedPath, "utf8");
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown file system error";
    throw new ConfigError(`Failed to read config at ${resolvedPath}: ${message}`);
  }

  let parsedConfig: unknown;
  try {
    parsedConfig = JSON.parse(rawConfig);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown JSON parse error";
    throw new ConfigError(`Invalid JSON in config at ${resolvedPath}: ${message}`);
  }

  return normalizeConfig(parsedConfig);
};
