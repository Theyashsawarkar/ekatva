/**
 * An error as one short sentence for the screen: never a stack, a JSON dump
 * of validation issues, or a class name in front.
 */
interface Issue {
  code?: string;
  path?: unknown[];
  message?: string;
  minimum?: number;
  maximum?: number;
}

const NETWORK =
  /network request failed|failed to fetch|socket (closed|hang up)|ECONNRE|timed? ?out|aborted/i;

export function errorText(e: unknown): string {
  let m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  m = m.trim();
  if (!m) return "Something went wrong";
  // A laptop from before readable errors sends zod's issues as JSON.
  if (m.startsWith("[") || m.startsWith("{")) {
    try {
      const parsed = JSON.parse(m) as Issue[] | { issues?: Issue[]; message?: string };
      const issues = Array.isArray(parsed) ? parsed : parsed.issues;
      const i = issues?.[0];
      if (i) {
        const field = (i.path ?? []).filter((p) => typeof p === "string").join(".") || "The value";
        if (i.code === "too_small" && i.minimum !== undefined)
          return `${field} must be at least ${i.minimum}`;
        if (i.code === "too_big" && i.maximum !== undefined)
          return `${field} must be at most ${i.maximum}`;
        if (i.message) return i.message;
      }
      if (!Array.isArray(parsed) && parsed.message) m = parsed.message;
    } catch {
      // not JSON after all
    }
  }
  // A native function that threw: Expo says only "Call to function 'X.y' has
  // been rejected." and puts what went wrong on a "Caused by" line below.
  const cause = /^Call to function .* has been rejected\.?\s*\n.*?Caused by:\s*(.+)/s.exec(m)?.[1];
  if (cause) m = cause.replace(/^[\w.$]+(Exception|Error):\s*/, "");
  if (NETWORK.test(m)) return "The laptop didn't answer. Check the connection";
  m = m.replace(/^(TRPCClientError|TRPCError|Error|TypeError):\s*/i, "");
  m = m.split("\n")[0] ?? m;
  return m.length > 140 ? `${m.slice(0, 137)}…` : m;
}
