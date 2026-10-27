---
title: "For AI agents"
description: "Let Claude Code, Codex or any MCP client use your phone through ekatva, with you approving what reaches other people."
---

`ekatva mcp` is an [MCP](https://modelcontextprotocol.io) server on stdio.
Any agent on the laptop that speaks MCP can use the phone through it: read
its state, ring or lock it, read and send SMS, place calls, use its
clipboard and files, keep the laptop awake.

It talks to the daemon over the same local socket as the `ekatva` command
(yours alone, mode 0600), so an agent can do nothing you couldn't from a
terminal.

## Add it to an agent

Claude Code:

```sh
claude mcp add --scope user ekatva -e EKATVA_AGENT=claude -- ekatva mcp
```

Any other MCP client: run `ekatva mcp` as a stdio server. Set
`EKATVA_AGENT` to the agent's name so the action log says who did what
(`yash via claude`); it is a label, not a password.

An agent without MCP can use the command line instead (`ekatva status`,
`ekatva log`, ...); see [the CLI](/ekatva/reference/cli/).

## Tools

| Tool | What it does | Asks you first |
|---|---|---|
| `status` | the laptop, and which phones are paired and online | |
| `phone_status` | battery, signal, locked | |
| `phone_ring`, `phone_lock` | ring the phone, lock its screen | |
| `sms_threads`, `sms_read` | the phone's conversations and messages | |
| `sms_send` | send an SMS | **yes** |
| `call_dial` | place a call | **yes** |
| `call_hang_up` | end the current call | |
| `phone_clipboard_get`, `phone_clipboard_set` | the phone's clipboard | |
| `phone_files_list`, `phone_files_read` | the phone's shared folders | |
| `caffeine_set` | keep the laptop awake (off, on, high), for a while | |
| `log_recent` | the latest entries of the action log | |

## Safety

- **You approve what reaches other people.** `sms_send` and `call_dial`
  open an **Allow / Decline** dialog on the laptop with the number and the
  text (needs `zenity`). Closing it, or two minutes without an answer, is
  a no.
- **Everything is logged** in the [action log](/ekatva/features/action-log/)
  under the agent's name, and most of it can be undone (`ekatva undo N`).
- **The phone's grants still apply**: an agent can only do what you let the
  phone do (`ekatva grant`).
- **Other people's words are data.** SMS, the clipboard and files come back
  inside `<untrusted>` blocks, and the server tells the agent not to follow
  instructions found there.
