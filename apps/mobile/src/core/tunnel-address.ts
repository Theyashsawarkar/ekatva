/** An address you type for the laptop's tunnel: a hostname, from whatever was pasted. */
export function hostOf(input: string): string | null {
  const h = input
    .trim()
    .toLowerCase()
    .replace(/^(?:wss?|https?):\/\//, "")
    .replace(/[/?#].*$/, "")
    .replace(/\.$/, "");
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(h) ? h : null;
}
