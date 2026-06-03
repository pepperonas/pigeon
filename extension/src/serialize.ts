/**
 * Pure helpers for turning console arguments into a string message.
 * Kept browser-API-free so they can be unit-tested in plain Node.
 */

/** Render a single console argument as a string, robust to circular refs. */
export function serializeArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
  if (arg === undefined) return "undefined";
  if (arg === null) return "null";
  try {
    const json = JSON.stringify(arg);
    return json === undefined ? String(arg) : json;
  } catch {
    return String(arg); // circular / non-serializable
  }
}

/** Join console arguments into a single message string. */
export function buildMessage(args: unknown[]): string {
  return args.map(serializeArg).join(" ");
}
