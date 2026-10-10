/** Strip markup/control characters from untrusted provider text before it reaches the UI or an LLM. */
export function sanitizeText(input: unknown, maxLen = 200): string {
  if (typeof input !== "string") return "";
  return input
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

/** Only same-site relative paths are allowed as post-login redirects (prevents open redirects). */
export function safeRedirectPath(next: string | null | undefined, fallback = "/dashboard"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\") || /[\u0000-\u001f]/.test(next)) return fallback;
  return next.slice(0, 200);
}

/** Redact fields that must never be logged. */
const SENSITIVE = /pass(word)?|token|secret|authorization|cookie|api[-_]?key|card|cvv|fullname|email|phone|dob|passport|aadhaar|pan\b/i;
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[depth]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SENSITIVE.test(k) ? "[redacted]" : redact(v, depth + 1)]),
    );
  }
  if (typeof value === "string") return value.length > 200 ? value.slice(0, 200) + "…" : value;
  return value;
}

export function log(level: "info" | "warn" | "error", event: string, data: Record<string, unknown> = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), level, event, ...(redact(data) as object) });
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}
