---
title: "Agents"
description: "Your Claude Code sessions, from the phone: see them, answer them, start them."
---

ekatva finds AI agent sessions in tmux (Claude Code, Codex, Aider, Gemini) and
reads each one's state from its screen:

| State | What you see |
|---|---|
| **working** | It's running (its status line says "esc to interrupt"), with what it's doing. |
| **waiting** | It's asking: the question and its options, exactly as on screen (numbered ones, and menus without numbers like "do you trust this folder?", answered by moving the cursor). |
| **done** | It finished its turn and is waiting for you (Claude's Stop hook marked it). |
| **idle** | Nothing happening. |

From the phone you can **answer** an option, **reply** with text (typed or
dictated), **interrupt** it (Esc), read its recent **output**, and **start a
new session** in any of your projects with a first prompt.

## Answers land where you meant

Each question has a hash. An answer carries the hash of the question you saw;
the daemon re-reads the screen and sends the key only if the same question is
still there. A late tap can't answer the next question by accident.

## Projects

New sessions start only in your projects: those Claude knows (`~/.claude.json`),
those open in tmux, and git repositories in `~/personal`, `~/codes`, `~/work`,
`~/projects`, `~/src` (configurable). Each runs in its own tmux session, with
a shell underneath so it stays when the agent exits.

The first prompt is typed only once the agent's input box is there. If it
asks something first (Claude asks whether to trust a folder it hasn't seen),
the session opens on the phone with that question; answer it there and the
prompt goes in after. If you say no, nothing is typed into the shell it
leaves.

```sh
ekatva agents
```
