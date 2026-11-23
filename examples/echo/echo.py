#!/usr/bin/env python3
"""The smallest laptop app on ekatva: says back what the phone sends.

    python3 examples/echo/echo.py

Then grant a phone "apps" and "app:echo" (ekatva grant <phone> apps app:echo)
and call it from the phone's echo app, or from the CLI:

    ekatva apps            # it's there, online
"""
import os
import signal
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../clients/python"))
from ekatva_app import App

MANIFEST = {
    "id": os.environ.get("ECHO_ID", "echo"),
    "name": "Echo",
    "version": "1",
    "methods": [
        {"name": "say", "why": "Says back what you send"},
        {"name": "time", "why": "The laptop's clock", "log": False},
    ],
    "events": [{"name": "note", "why": "A note, printed on the laptop"}],
}

app = App(MANIFEST, on_ready=lambda: print("echo: registered", flush=True),
          on_error=lambda e: print(f"echo: {e}", file=sys.stderr, flush=True))


@app.on("say")
def say(inp, sender):
    return {"said": inp, "to": sender.get("name"), "by": "python"}


@app.on("time")
def now(_inp, _sender):
    return {"ms": int(time.time() * 1000)}


@app.on_event("note")
def note(data, sender, _at):
    print(f"echo: a note from {sender.get('name')}: {data}", flush=True)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    app.start()
    try:
        signal.pause()
    except KeyboardInterrupt:
        pass
    app.close()
