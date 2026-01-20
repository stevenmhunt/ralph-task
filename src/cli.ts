#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { ConflictPrefer } from "./config.js";
import { ConfigError, DEFAULT_CONFIG_PATH, loadRalphtaskConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { RalphPrdFormatAdapter } from "./ralph-prd-adapter.js";
import { formatSyncPlan } from "./sync-plan-output.js";
import { SyncEngine } from "./sync-engine.js";
import { syncWithStateFile } from "./sync-with-state.js";
import { TrelloBoardAdapter } from "./trello-adapter.js";

const VALID_PREFER_VALUES: ConflictPrefer[] = ["none", "trello", "prd"];

interface SyncCommandOptions {
  configPath?: string;
  prefer?: ConflictPrefer;
}

interface ParseResult {
  command?: "sync";
  options?: SyncCommandOptions;
  error?: string;
  showHelp?: boolean;
}

const USAGE = [
  "Usage:",
  "  ralph-task sync [--config <path>] [--prefer <trello|prd|none>]",
  "",
  "Options:",
  "  --config   Path to ralph task configuration file (default: .ralphtask.json)",
  "  --prefer   Resolve equal-timestamp conflicts in favor of trello or prd",
];

const parseOptionValue = (
  arg: string,
  argv: string[],
  index: number,
): { value?: string; nextIndex: number; error?: string } => {
  const equalsIndex = arg.indexOf("=");
  if (equalsIndex !== -1) {
    const value = arg.slice(equalsIndex + 1);
    if (!value) {
      return {
        nextIndex: index,
        error: `Missing value for ${arg.slice(0, equalsIndex)}`,
      };
    }
    return { value, nextIndex: index };
  }
  const value = argv[index + 1];
  if (!value) {
    return { nextIndex: index, error: `Missing value for ${arg}` };
  }
  return { value, nextIndex: index + 1 };
};

const parseArgs = (argv: string[]): ParseResult => {
  if (argv.length === 0) {
    return { error: "Missing command." };
  }

  const command = argv[0];
  if (command !== "sync") {
    return { error: `Unknown command '${command}'.` };
  }

  const options: SyncCommandOptions = {};

  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      return { command: "sync", options, showHelp: true };
    }
    if (arg === "--config" || arg.startsWith("--config=")) {
      const parsed = parseOptionValue(arg, argv, i);
      if (parsed.error) {
        return { error: parsed.error };
      }
      options.configPath = parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    if (arg === "--prefer" || arg.startsWith("--prefer=")) {
      const parsed = parseOptionValue(arg, argv, i);
      if (parsed.error) {
        return { error: parsed.error };
      }
      const prefer = parsed.value?.toLowerCase() as ConflictPrefer | undefined;
      if (!prefer || !VALID_PREFER_VALUES.includes(prefer)) {
        return {
          error:
            `Invalid --prefer value '${parsed.value}'. ` +
            `Expected one of: ${VALID_PREFER_VALUES.join(", ")}`,
        };
      }
      options.prefer = prefer;
      i = parsed.nextIndex;
      continue;
    }
    return { error: `Unknown option '${arg}'.` };
  }

  return { command: "sync", options };
};

const printUsage = (): void => {
  process.stderr.write(`${USAGE.join("\n")}\n`);
};

const resolveCliPath = (value: string): string =>
  path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);

const resolveFromBase = (value: string, baseDir: string): string =>
  path.isAbsolute(value) ? value : path.resolve(baseDir, value);

const runSyncCommand = async (options: SyncCommandOptions): Promise<void> => {
  const configPath = resolveCliPath(options.configPath ?? DEFAULT_CONFIG_PATH);
  const config = await loadRalphtaskConfig(configPath);
  const configDir = path.dirname(configPath);
  const logger = createLogger({
    level: config.logging.level,
    format: config.logging.format,
  });

  const boardAdapter = new TrelloBoardAdapter({
    ...config.trello,
    retry: config.sync.retry,
  });
  const formatAdapter = new RalphPrdFormatAdapter();
  const engine = new SyncEngine({ boardAdapter, formatAdapter });

  const conflict: (typeof config)["conflict"] & { prefer?: ConflictPrefer } = {
    ...config.conflict,
  };
  if (options.prefer !== undefined) {
    conflict.prefer = options.prefer;
  }

  const { plan } = await syncWithStateFile(engine, {
    prdPath: resolveFromBase(config.paths.prdFile, configDir),
    statePath: resolveFromBase(config.paths.stateFile, configDir),
    boardId: config.trello.boardId,
    mapping: config.mapping,
    direction: config.sync.direction,
    incremental: config.sync.incremental,
    dryRun: config.sync.dryRun,
    conflict,
    logger,
    warn: (message) => logger.warn(message),
  });

  if (config.logging.format === "json") {
    process.stdout.write(`${JSON.stringify({ plan }, null, 2)}\n`);
  } else {
    process.stdout.write(formatSyncPlan(plan));
  }
};

const isDirectRun = (): boolean => {
  if (!process.argv[1]) {
    return false;
  }
  const currentPath = fileURLToPath(import.meta.url);
  return path.resolve(process.argv[1]) === currentPath;
};

const handleError = (error: unknown): void => {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (error instanceof Error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write("Unknown error\n");
  process.exitCode = 1;
};

export const runCli = async (argv = process.argv.slice(2)): Promise<void> => {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n`);
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (parsed.showHelp) {
    printUsage();
    return;
  }
  try {
    if (parsed.command === "sync") {
      await runSyncCommand(parsed.options ?? {});
      return;
    }
    process.stderr.write("Missing command.\n");
    printUsage();
    process.exitCode = 1;
  } catch (error) {
    handleError(error);
  }
};

if (isDirectRun()) {
  runCli().catch(handleError);
}
