---
title: "The window's keys"
description: "Vim-like keys in the desktop window: Normal and Insert mode, Space as the leader."
---

The desktop window is driven by the keyboard, the way every Vayu tool is.

- **Normal mode** (the pill at the top says `NORMAL`): keys are commands, and
  typing changes nothing.
- **Insert mode** (`INSERT`): you're typing in a text field. <kbd>Esc</kbd>
  goes back to Normal mode. <kbd>i</kbd> on the Phone tab starts typing the
  clipboard text.
- **<kbd>Space</kbd> is the leader.** After it, a strip at the bottom shows the
  keys that can follow (after a third of a second; <kbd>Esc</kbd> cancels).
  The groups are the same in every Vayu tool: `t` tabs, `a` add, `d` delete,
  `m` mark, `y` copy or send; `c` (caffeine) and `p` (the phone) are
  ekatva's own.
- A number before a key repeats it: <kbd>5</kbd><kbd>j</kbd>. A count can't
  start with <kbd>1</kbd>-<kbd>4</kbd>: those switch tabs.
- Anything that can't be taken back asks first: <kbd>y</kbd> says yes, any
  other key says no.

## Everywhere

| Keys | What they do |
|---|---|
| `H` / `L` | previous / next tab |
| `1` `2` `3` `4` | Phones, Log, Caffeine, Phone |
| `r` | reload what the tab shows |
| `?` or `Space ?` | the keys of this tab |
| `Space Space` | a palette of every key (type, then Enter) |
| `Space t p` / `t l` / `t c` / `t h` | the Phones / Log / Caffeine / Phone tab |
| `Space c o` / `c i` / `c h` | caffeine off / on / high |
| `Space p r` | ring the phone |
| `Space p l` | lock the phone |
| `Space p k` | keep its screen on, or let it sleep |
| `Space a p` | pair a phone |
| `Space q` | close the window |
| `Esc` | close the pairing code, a panel or the help |

## Phones

| Keys | What they do |
|---|---|
| `j` / `k`, `gg` / `G` | move in the list or in its permissions |
| `h` / `l` | the phone list / its permissions |
| `Enter` or `Space m g` | allow or stop the selected permission |
| `Space d d` | unpair the phone (asks first) |
| `Enter` / `x` | pairing: they match, pair / refuse it |

## Log, Caffeine, Phone

| Keys | What they do |
|---|---|
| `j` / `k`, `gg` / `G` | move (Log: newest first) |
| `u` | Log: undo the selected entry (asks first) |
| `Enter` | Caffeine: set the selected level · Phone: open the folder |
| `l` / `h` | Phone: open the folder / up a folder |
| `i` | Phone: type clipboard text |
| `Space y c` | Phone: send the clipboard text |

**Changed in this release:** `p` (pair), `o` / `i` / `h` (caffeine) and `r`
(ring) worked from every tab; they moved under the leader (`Space a p`,
`Space c …`, `Space p r`), so a stray key can no longer ring the phone. `r`
reloads now, and a single `g` no longer jumps to the top (`gg` does). For this
release a moved key says where it went instead of doing nothing.
