import { pino, type Logger, type LoggerOptions } from "pino";

export const LOG_SCHEMA_VERSION = "1";

export const DEFAULT_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  "headers.authorization",
  "headers.cookie",
  'headers["set-cookie"]',
  "password",
  "password_hash",
  "passwordHash",
  "token",
  "access_token",
  "refresh_token",
  "session_token",
  "api_key",
  "apiKey",
  "secret",
  "*.password",
  "*.password_hash",
  "*.token",
  "*.secret",
];

export interface CreateLoggerOptions {
  /** Service / app name written into every line as `service`. */
  service: string;
  /** Defaults to `process.env.LOG_LEVEL` or `"info"`. */
  level?: LoggerOptions["level"];
  /** Additional redact paths merged with the defaults. */
  redactPaths?: readonly string[];
  /** Pretty-print to a TTY (dev only); ignored in production. */
  pretty?: boolean;
  /** Bindings to attach to the root logger. */
  bindings?: Record<string, unknown>;
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  const redactPaths = mergeRedactPaths(DEFAULT_REDACT_PATHS, opts.redactPaths);
  const level = opts.level ?? process.env["LOG_LEVEL"] ?? "info";

  const baseBindings: Record<string, unknown> = {
    service: opts.service,
    log_schema_version: LOG_SCHEMA_VERSION,
    ...(opts.bindings ?? {}),
  };

  const options: LoggerOptions = {
    level,
    base: baseBindings,
    redact: {
      paths: [...redactPaths],
      censor: "[REDACTED]",
      remove: false,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
    },
    messageKey: "message",
  };

  if (opts.pretty && process.stdout.isTTY) {
    options.transport = {
      target: "pino-pretty",
      options: { colorize: true, singleLine: true },
    };
  }

  return pino(options);
}

export interface RequestContext {
  tenant_id?: string | null;
  request_id: string;
  user_id?: string | null;
  store_id?: string | null;
}

/**
 * Per-request child logger. Every log line emitted from the returned logger
 * carries `tenant_id` and `request_id` (Constitution VII).
 */
export function withRequestContext(
  logger: Logger,
  ctx: RequestContext,
): Logger {
  return logger.child({
    request_id: ctx.request_id,
    tenant_id: ctx.tenant_id ?? null,
    user_id: ctx.user_id ?? null,
    store_id: ctx.store_id ?? null,
  });
}

function mergeRedactPaths(
  defaults: readonly string[],
  extra: readonly string[] | undefined,
): readonly string[] {
  if (!extra || extra.length === 0) return defaults;
  const seen = new Set<string>(defaults);
  for (const p of extra) seen.add(p);
  return Array.from(seen);
}
