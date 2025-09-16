type Level = "debug" | "info" | "warn" | "error";

const ENABLED = (process.env?.LOG_LEVEL as string | undefined ?? "info").toLowerCase();
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function emit(level: Level, tag: string, msg: string, meta?: unknown) {
  if (order[level] < order[(ENABLED as Level) in order ? (ENABLED as Level) : "info"]) return;
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] [${tag}] ${msg}`;
  if (meta !== undefined) {
    // Avoid dumping huge objects unintentionally
    console.log(line, JSON.stringify(meta));
  } else {
    console.log(line);
  }
}

export const log = {
  debug: (tag: string, msg: string, meta?: unknown) => emit("debug", tag, msg, meta),
  info: (tag: string, msg: string, meta?: unknown) => emit("info", tag, msg, meta),
  warn: (tag: string, msg: string, meta?: unknown) => emit("warn", tag, msg, meta),
  error: (tag: string, msg: string, meta?: unknown) => emit("error", tag, msg, meta),
};
