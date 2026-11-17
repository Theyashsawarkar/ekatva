---
title: "The window's keys"
description: "Vim-like keys in the laptop's popup: Normal and Insert mode, Space as the leader."
---

On the laptop, ekatva is a [Vyom](https://github.com/Theyashsawarkar/vyom) popup
([Darpaṇa](https://github.com/Theyashsawarkar/darpana)), driven by the
keyboard the way every Vayu tool is. In Vayu, <kbd>Super</kbd>+<kbd>o</kbd>
opens it and <kbd>Super</kbd>+<kbd>Ctrl</kbd>+<kbd>o</kbd> opens it on pairing.

- **Normal mode** (`NORMAL` at the bottom): keys are commands, and typing
  changes nothing. The popup opens with nothing selected, so a stray
  <kbd>Enter</kbd> does nothing.
- **Insert mode** (`INSERT`): <kbd>i</kbd> types in the place's box (a message
  on Messages, a number on Calls); <kbd>Esc</kbd> goes back.
- **<kbd>Space</kbd> is the leader.** After it, a strip shows the keys that can
  follow. The groups are the same in every Vayu tool: `g` go to, `y` copy,
  `a` add, `r` refresh; `j` (jyoti), `p` (the phone) and `l` (light and
  dark) are ekatva's own.
- Anything that can't be taken back asks first: <kbd>y</kbd> says yes, any
  other key says no.

## Everywhere

| Keys | What they do |
|---|---|
| `j` / `k`, `gg` / `G` | move between the controls of the place you're on |
| `Enter` | press the selected control (a switch: flip it) |
| `H` / `L`, `Ctrl+1`…`Ctrl+6` | the places: Overview, Messages, Calls, Files, Log, Devices |
| `?` or `Space ?` | every key here |
| `Space Space` | a palette of every action (type, then Enter) |
| `Space j s` / `j a` / `j n` | jyoti Śānta / Akhaṇḍa / Nandādīpa |
| `Space p r` | ring the phone until you press it again (find my phone) |
| `Space p a` / `Space p h` | answer / hang up (or decline) the phone's call |
| `Space p l` | lock the phone |
| `Space p k` | keep its screen on, or let it sleep |
| `Space p d` | dial a number from the phone |
| `Space l l` / `l p` / `l b` | light or dark: this laptop / the phone / both |
| `Space g o` / `g m` / `g c` / `g f` / `g l` / `g d` | go to a place |
| `Space y c` | copy the phone's clipboard to this laptop's |
| `Space y p` | copy this laptop's clipboard to the phone |
| `Space a p` | pair a phone |
| `Space a f` | send a file to the phone |
| `Space r` | reload what this place shows |
| `Esc` | back: up a folder, close pairing, then close the popup |
