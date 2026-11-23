/**
 * The link to one agent session. Its id is a tmux pane, "%6"; Expo Router
 * percent-decodes route params, so "%15" would arrive as a control character
 * and "%6" mangled ("not a pane" from the laptop). The route carries "p6"
 * instead, and the screen turns it back.
 */
export const agentRoute = (id: string) =>
  ({ pathname: "/agent/[id]", params: { id: id.replace(/^%/, "p") } }) as const;

/** The pane id from the route's param ("p6" → "%6"); anything else as it is. */
export const paneOf = (param: string | string[] | undefined): string => {
  const p = Array.isArray(param) ? (param[0] ?? "") : (param ?? "");
  return /^p\d+$/.test(p) ? `%${p.slice(1)}` : p;
};
