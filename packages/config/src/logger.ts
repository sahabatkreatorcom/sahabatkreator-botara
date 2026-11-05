/**
 * Logger terstruktur (JSON lines) untuk seluruh proses server Sahabat Kreator.
 *
 * Kenapa di @sahabat-kreator/config: API, worker, realtime, dan skrip
 * operasional semuanya butuh format log yang sama, dan paket ini sudah
 * menjadi satu-satunya dependensi bersama yang aman (tanpa Hono/BullMQ).
 *
 * Aturan:
 * - SATU baris JSON per event, ditulis ke stdout (debug/info) atau stderr
 *   (warn/error) agar mudah ditangkap journald/Docker/CloudWatch.
 * - Field sensitif di-redact secara rekursif berdasarkan nama kunci
 *   (token, secret, password, authorization, cookie, api key).
 * - `Error` diserialisasi menjadi { name, message, stack } — stack TIDAK
 *   pernah ikut ke respons HTTP; pemanggil yang menentukan apa yang dikirim.
 * - Tidak ada dependensi eksternal: logger ini sengaja kecil dan deterministik.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_WEIGHT: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Logger anak: field dasar digabung dengan field per event. */
  child(fields: LogFields): Logger;
}

export interface LoggerOptions {
  /** Ambang level; default "info". */
  level?: LogLevel;
  /** Field yang selalu ikut di setiap baris (mis. service, version). */
  base?: LogFields;
  /** Tujuan tulisan; default process.stdout/stderr. Dipakai uji deterministik. */
  sink?: (line: string, level: LogLevel) => void;
  /** Sumber waktu; default `new Date()`. Dipakai uji deterministik. */
  now?: () => Date;
}

const REDACTED = "[redacted]";

/**
 * Nama kunci yang nilainya tidak boleh muncul di log. Sengaja lebar:
 * lebih baik kehilangan sedikit konteks debug daripada membocorkan token.
 */
const SECRET_KEY_PATTERN =
  /(token|secret|password|passwd|authorization|cookie|api[-_]?key|private[-_]?key|credential|session[-_]?id)/i;

const MAX_DEPTH = 6;

/** Serialisasi nilai menjadi struktur JSON-safe + redaksi kunci sensitif. */
export function sanitizeLogValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    // String panjang (payload) dipotong agar log tidak meledak.
    return value.length > 2_000 ? `${value.slice(0, 2_000)}…[truncated]` : value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return undefined;

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {}),
      ...(value.cause !== undefined
        ? { cause: sanitizeLogValue(value.cause, depth + 1) }
        : {}),
    };
  }

  if (depth >= MAX_DEPTH) return "[max-depth]";

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeLogValue(item, depth + 1));
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY_PATTERN.test(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = sanitizeLogValue(item, depth + 1);
      }
    }
    return out;
  }

  return String(value);
}

function defaultSink(line: string, level: LogLevel): void {
  const stream = level === "warn" || level === "error" ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

/**
 * Membuat logger. `service` wajib agar setiap baris bisa difilter per proses.
 *
 * @example
 * const log = createLogger("api", { level: env.LOG_LEVEL });
 * log.info("http.request", { requestId, method, path, status, durationMs });
 */
export function createLogger(service: string, options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const threshold = LEVEL_WEIGHT[level];
  const base: LogFields = { service, ...options.base };
  const sink = options.sink ?? defaultSink;
  const now = options.now ?? (() => new Date());

  function emit(entryLevel: LogLevel, message: string, fields?: LogFields): void {
    if (LEVEL_WEIGHT[entryLevel] < threshold) return;
    const record = {
      time: now().toISOString(),
      level: entryLevel,
      msg: message,
      ...(sanitizeLogValue(base) as Record<string, unknown>),
      ...(fields ? (sanitizeLogValue(fields) as Record<string, unknown>) : {}),
    };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      // Jangan pernah gagal karena log: jatuh ke representasi minimal.
      line = JSON.stringify({
        time: record.time,
        level: entryLevel,
        msg: message,
        logError: "serialization_failed",
      });
    }
    sink(line, entryLevel);
  }

  const logger: Logger = {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) =>
      createLogger(service, {
        level,
        base: { ...base, ...fields },
        sink,
        now,
      }),
  };

  return logger;
}
