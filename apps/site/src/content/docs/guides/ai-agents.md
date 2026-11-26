---
title: "For AI agents"
description: "Let Claude Code, Codex or any MCP client use your phone through ekatva, with you approving what reaches other people."
---

`ekatva mcp` is an [MCP](https://modelcontextprotocol.io) server on stdio.
Any agent on the laptop that speaks MCP can use the phone through it: read
its state, ring or lock it, read and send SMS, place calls, use its
clipboard and files, keep the laptop awake.

The daemon serves the tools itself, on its MCP socket
(`$XDG_RUNTIME_DIR/ekatva/mcp.sock`, yours alone, mode 0600); `ekatva mcp`
is a small Rust pipe from the agent's stdio to it (`ekatva-rs`, built in
`apps/daemon-rs`), so six sessions don't cost six Node processes. The tools
call the same router as the `ekatva` command, so an agent can do nothing
you couldn't from a terminal. When the service restarts (an update), the
pipe reconnects: a call the old daemon didn't answer fails with "ekatva
daemon restarted; try again", and the session goes on. Without the Rust
binary, or with an older daemon, `ekatva mcp` is the Node server over the
local socket, as before.

## Add it to an agent

Claude Code:

```sh
claude mcp add --scope user ekatva -e EKATVA_AGENT=claude -- ekatva mcp
```

Any other MCP client: run `ekatva mcp` as a stdio server. Set
`EKATVA_AGENT` to the agent's name so the action log says who did what
(`yash via claude`); it is a label, not a password.

An agent without MCP can use the command line instead (`ekatva status`,
`ekatva log`, ...); see [the CLI](/reference/cli/).

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
| `jyoti_set` | jyoti: keep the laptop awake (off = Śānta; on = Akhaṇḍa; high = Nandādīpa, with the lid closed), for a while | |
| `log_recent` | the latest entries of the action log | |

## Safety

- **You approve what reaches other people.** `sms_send` and `call_dial`
  open an **Allow / Decline** dialog on the laptop with the number and the
  text (needs `zenity`). Closing it, or two minutes without an answer, is
  a no.
- **Everything is logged** in the [action log](/features/action-log/)
  under the agent's name, and most of it can be undone (`ekatva undo N`).
- **The phone's grants still apply**: an agent can only do what you let the
  phone do (`ekatva grant`).
- **Other people's words are data.** SMS, the clipboard and files come back
  inside `<untrusted>` blocks, and the server tells the agent not to follow
  instructions found there.
