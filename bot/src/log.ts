export type Level = "debug" | "info" | "warn" | "error";

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function isLevel(s: string): s is Level {
  return Object.hasOwn(RANK, s);
}

export type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

function fmt(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return /\s/.test(v) ? JSON.stringify(v) : v;
  if (v instanceof Error) return JSON.stringify(v.message);
  return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
}

export function createLogger(name: string, level: Level = "info", sink: (line: string) => void = console.log): Logger {
  const emit = (lvl: Level, msg: string, fields?: Fields) => {
    if (RANK[lvl] < RANK[level]) return;
    const kv = fields
      ? Object.entries(fields)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => `${k}=${fmt(v)}`)
          .join(" ")
      : "";
    sink(`${new Date().toISOString()} ${lvl.toUpperCase().padEnd(5)} [${name}] ${msg}${kv ? ` ${kv}` : ""}`);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

/** Shortest useful description of a viem or fetch error. */
export function errMsg(e: unknown): string {
  if (e && typeof e === "object") {
    const o = e as { shortMessage?: unknown; message?: unknown };
    if (typeof o.shortMessage === "string") return o.shortMessage;
    if (typeof o.message === "string") return o.message.split("\n")[0] ?? o.message;
  }
  return String(e);
}
