import type { LogFormat, LogLevel } from "./config.js";

export type LogData = Record<string, unknown>;

export interface LogEntry {
  level: Exclude<LogLevel, "silent">;
  message: string;
  timestamp: string;
  data?: LogData;
}

export interface Logger {
  level: LogLevel;
  format: LogFormat;
  debug: (message: string, data?: LogData) => void;
  info: (message: string, data?: LogData) => void;
  warn: (message: string, data?: LogData) => void;
  error: (message: string, data?: LogData) => void;
}

export interface LoggerOptions {
  level: LogLevel;
  format: LogFormat;
  output?: NodeJS.WritableStream;
  errorOutput?: NodeJS.WritableStream;
  time?: () => string;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 50,
};

const shouldLog = (configLevel: LogLevel, entryLevel: LogLevel): boolean => {
  if (configLevel === "silent") {
    return entryLevel === "error";
  }
  return LEVEL_ORDER[entryLevel] >= LEVEL_ORDER[configLevel];
};

const formatTextEntry = (entry: LogEntry): string => {
  const base = `${entry.timestamp} ${entry.level.toUpperCase()} ${entry.message}`;
  if (!entry.data || Object.keys(entry.data).length === 0) {
    return base;
  }
  return `${base} ${JSON.stringify(entry.data)}`;
};

const formatJsonEntry = (entry: LogEntry): string => JSON.stringify(entry);

const buildEntry = (
  level: Exclude<LogLevel, "silent">,
  message: string,
  data: LogData | undefined,
  time: () => string,
): LogEntry => {
  const entry: LogEntry = {
    level,
    message,
    timestamp: time(),
  };
  if (data && Object.keys(data).length > 0) {
    entry.data = data;
  }
  return entry;
};

export const createLogger = (options: LoggerOptions): Logger => {
  const output = options.output ?? process.stdout;
  const errorOutput = options.errorOutput ?? process.stderr;
  const time = options.time ?? (() => new Date().toISOString());

  const write = (
    level: Exclude<LogLevel, "silent">,
    message: string,
    data?: LogData,
  ): void => {
    if (!shouldLog(options.level, level)) {
      return;
    }
    const entry = buildEntry(level, message, data, time);
    const line = options.format === "json"
      ? formatJsonEntry(entry)
      : formatTextEntry(entry);
    const stream = level === "warn" || level === "error" ? errorOutput : output;
    stream.write(`${line}\n`);
  };

  return {
    level: options.level,
    format: options.format,
    debug: (message, data) => write("debug", message, data),
    info: (message, data) => write("info", message, data),
    warn: (message, data) => write("warn", message, data),
    error: (message, data) => write("error", message, data),
  };
};
