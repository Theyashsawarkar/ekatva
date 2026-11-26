"""For a laptop app in Python to talk to the phone's apps through ekatva.

    from ekatva_app import App

    app = App({"id": "nada", "name": "nāda", "version": "1",
               "methods": [{"name": "play", "why": "Play the laptop's music"}],
               "events": [{"name": "handoff", "why": "Continue what the phone played"}]})

    @app.on("play")
    def play(inp, sender):          # sender: {"key": ..., "name": "Pixel 8"}
        return {"playing": True}    # or raise: the phone gets the message

    @app.on_event("handoff")
    def handoff(data, sender, at):
        ...

    @app.on("open")
    def open_(inp, sender, files):  # a third argument: the files sent with the call
        ...                         # (each {"name", "size", "mime", "path"})

    app.start()                     # asks to link, and stays connected
    app.call("queue")               # the phone's nāda (blocks: not on a UI thread)
    app.call("addBook", {"title": "…"}, to="phone:vagdevi", files=["/tmp/a.epub"])

The first time, it asks to link: you accept it in Darpaṇa (Apps), once, and
it's linked for good (`on_status` and `.status` say where it stands:
"waiting", "linked", "refused"). It stays connected over ekatva's local
socket ($EKATVA_SOCKET, else $XDG_RUNTIME_DIR/ekatva.sock: yours alone):
when the service restarts it connects again by itself. Calling an app other
than its own other half asks you once in Darpaṇa (a route).

One file, the standard library only: copy it into a tool, or put
clients/python on its path. Handlers run on worker threads, never on the
caller's: a GTK app hands results to its main loop itself (GLib.idle_add).
"""
import base64
import inspect
import itertools
import json
import os
import socket
import struct
import threading
from concurrent.futures import ThreadPoolExecutor

__all__ = ["App", "Down", "EkatvaError", "socket_path"]


def socket_path():
    return os.environ.get("EKATVA_SOCKET") or os.path.join(
        os.environ.get("XDG_RUNTIME_DIR") or os.path.expanduser("~/.local/state"), "ekatva.sock")


class EkatvaError(Exception):
    """What ekatva (or the phone) said went wrong, in its own words."""


class Down(EkatvaError):
    """ekatva's service isn't running, or went away."""


class _Socket:
    """One WebSocket over the Unix socket: tRPC messages in, a reader thread out."""

    def __init__(self, path, on_message, on_close):
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.settimeout(5)
        try:
            s.connect(path)
            key = base64.b64encode(os.urandom(16)).decode()
            s.sendall((
                "GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n"
                f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n"
            ).encode())
            head = b""
            while b"\r\n\r\n" not in head:
                chunk = s.recv(1024)
                if not chunk:
                    raise Down("the ekatva service closed the connection")
                head += chunk
            if b" 101 " not in head.split(b"\r\n", 1)[0]:
                raise Down("the ekatva service refused the connection")
            rest = head.split(b"\r\n\r\n", 1)[1]
        except OSError as e:
            s.close()
            raise Down(f"can't reach the ekatva service ({e.strerror or e})") from e
        s.settimeout(None)
        self.sock = s
        self.lock = threading.Lock()
        self.on_message = on_message
        self.on_close = on_close
        threading.Thread(target=self._read, args=(rest,), daemon=True, name="ekatva-app").start()

    def send(self, obj):
        data = json.dumps(obj).encode()
        mask = os.urandom(4)
        n = len(data)
        head = bytes([0x81])
        if n < 126:
            head += bytes([0x80 | n])
        elif n < 65536:
            head += bytes([0x80 | 126]) + struct.pack(">H", n)
        else:
            head += bytes([0x80 | 127]) + struct.pack(">Q", n)
        body = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        with self.lock:
            self.sock.sendall(head + mask + body)

    def close(self):
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        self.sock.close()

    def _read(self, buf):
        s = self.sock

        def need(k):
            nonlocal buf
            while len(buf) < k:
                chunk = s.recv(65536)
                if not chunk:
                    raise ConnectionError("closed")
                buf += chunk
            out, buf = buf[:k], buf[k:]
            return out

        message = b""
        try:
            while True:
                b0, b1 = need(2)
                op, n = b0 & 0x0F, b1 & 0x7F
                if n == 126:
                    n = struct.unpack(">H", need(2))[0]
                elif n == 127:
                    n = struct.unpack(">Q", need(8))[0]
                mask = need(4) if b1 & 0x80 else None
                payload = need(n)
                if mask:
                    payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
                if op == 0x8:
                    break
                if op == 0x9:
                    with self.lock:
                        s.sendall(bytes([0x8A, 0x80 | len(payload)]) + b"\0\0\0\0" + payload)
                    continue
                if op in (0x0, 0x1, 0x2):
                    message += payload
                    if b0 & 0x80:
                        try:
                            self.on_message(json.loads(message))
                        except ValueError:
                            pass
                        message = b""
        except (OSError, ConnectionError, ValueError):
            pass
        self.close()
        self.on_close(self)


def _readable(err):
    message = (err or {}).get("message") or "something went wrong"
    return message[:1].upper() + message[1:]


class App:
    """One app, registered with ekatva while it runs."""

    def __init__(self, manifest, path=None, on_ready=None, on_error=None, workers=4,
                 on_status=None):
        if not isinstance(manifest, dict) or not manifest.get("id"):
            raise ValueError("a manifest needs at least an id, a name and a version")
        self.manifest = manifest
        self.path = path or socket_path()
        self.on_ready = on_ready
        self.on_error = on_error or (lambda e: None)
        self.on_status = on_status
        self.status = "connecting"   # then "waiting" (for you, in Darpaṇa), "linked" or "refused"
        self.handlers = {}
        self.events = {}
        self.ids = itertools.count(1)
        self.waiting = {}          # id -> [Event, result, error]
        self.sock = None
        self.lock = threading.Lock()
        self.stopped = threading.Event()
        self.dropped = threading.Event()
        self.pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="ekatva-app-call")
        self.reg_id = None
        self.thread = None

    # ------------------------------------------------------------ handlers
    def on(self, method, fn=None):
        """Answer the phone's calls to `method` (decorator, or on(name, fn))."""
        names = {m.get("name") for m in self.manifest.get("methods", [])}
        if method not in names:
            raise ValueError(f'"{method}" isn\'t in {self.manifest.get("name")}\'s manifest')

        def put(f):
            self.handlers[method] = f
            return f
        return put(fn) if fn else put

    def on_event(self, name, fn=None):
        """Take the phone's `name` events: fn(data, sender, at)."""
        names = {m.get("name") for m in self.manifest.get("events", [])}
        if name not in names:
            raise ValueError(f'"{name}" isn\'t in {self.manifest.get("name")}\'s manifest events')

        def put(f):
            self.events[name] = f
            return f
        return put(fn) if fn else put

    # ------------------------------------------------------------ running
    def start(self):
        """Registers in the background, and again whenever the service comes back."""
        if self.thread is None:
            self.thread = threading.Thread(target=self._keep, daemon=True, name="ekatva-app-keep")
            self.thread.start()
        return self

    def close(self):
        self.stopped.set()
        self.dropped.set()
        sock = self.sock
        if sock is not None:
            sock.close()
        self.pool.shutdown(wait=False, cancel_futures=True)

    def _keep(self):
        delay = 0.5
        while not self.stopped.is_set():
            try:
                self._connect()
                delay = 0.5
                self.dropped.wait()
            except Down as e:
                self.on_error(e)
            if self.stopped.wait(delay):
                break
            delay = min(10.0, delay * 2)

    def _connect(self):
        if not os.path.exists(self.path):
            raise Down("the ekatva service isn't running")
        self.dropped.clear()
        sock = _Socket(self.path, self._dispatch, self._closed)
        with self.lock:
            self.sock = sock
        self.reg_id = next(self.ids)
        sock.send({"id": self.reg_id, "method": "subscription",
                   "params": {"path": "apps.register", "input": self.manifest}})

    def _closed(self, sock):
        with self.lock:
            if self.sock is sock:
                self.sock = None
        for slot in list(self.waiting.values()):
            if not slot[0].is_set():
                slot[2] = Down("the ekatva service went away")
                slot[0].set()
        self.dropped.set()

    def _dispatch(self, msg):
        mid = msg.get("id")
        if mid == self.reg_id:
            if "error" in msg:
                self.on_error(EkatvaError(_readable(msg["error"])))
                return
            res = msg.get("result") or {}
            if res.get("type") == "started" and self.on_ready:
                self.pool.submit(self.on_ready)
            if res.get("type") == "data":
                self.pool.submit(self._incoming, res.get("data") or {})
            return
        slot = self.waiting.get(mid)
        if slot is None:
            return
        if "error" in msg:
            slot[2] = EkatvaError(_readable(msg["error"]))
        else:
            slot[1] = (msg.get("result") or {}).get("data")
        slot[0].set()

    def _incoming(self, m):
        sender = m.get("from") or {}
        if m.get("kind") == "status":
            self.status = m.get("status") or "connecting"
            if self.on_status:
                try:
                    self.on_status(self.status, m.get("why"))
                except Exception as e:  # noqa: BLE001
                    self.on_error(e)
            return
        if m.get("kind") == "event":
            fn = self.events.get(m.get("name"))
            if fn:
                try:
                    fn(m.get("data"), sender, m.get("at"))
                except Exception as e:  # noqa: BLE001 -- an app's bug mustn't stop the others
                    self.on_error(e)
            return
        if m.get("kind") != "call":
            return
        fn = self.handlers.get(m.get("method"))
        try:
            if fn is None:
                raise EkatvaError(f'{self.manifest.get("name")} doesn\'t answer "{m.get("method")}" yet')
            args = [m.get("input"), sender]
            if _takes(fn, 3):
                args.append(m.get("files") or [])
            reply = {"id": m["id"], "ok": True, "result": fn(*args)}
        except Exception as e:  # noqa: BLE001 -- the phone gets the message, in words
            reply = {"id": m["id"], "ok": False, "error": (str(e) or type(e).__name__)[:500]}
        try:
            self._request("mutation", "apps.reply", reply, timeout=10)
        except EkatvaError as e:
            self.on_error(e)

    # ------------------------------------------------------------ the phone
    def _request(self, method, path, inp, timeout=20):
        sock = self.sock
        if sock is None:
            raise Down("not connected to the ekatva service")
        mid = next(self.ids)
        slot = [threading.Event(), None, None]
        self.waiting[mid] = slot
        try:
            try:
                sock.send({"id": mid, "method": method, "params": {"path": path, "input": inp}})
            except OSError as e:
                raise Down(f"lost the ekatva service ({e.strerror or e})") from e
            if not slot[0].wait(timeout):
                raise Down("the ekatva service didn't answer")
            if slot[2]:
                raise slot[2]
            return slot[1]
        finally:
            self.waiting.pop(mid, None)

    def call(self, method, inp=None, app=None, device=None, timeout=20, to=None, files=None):
        """Call an app: `to` "phone:APP" or "laptop:APP" (default: this app's half on
        the phone); `files` are paths sent along. Blocks (a new route waits for you)."""
        return self._request("mutation", "apps.invoke", {
            "to": to or f'phone:{app or self.manifest["id"]}', "method": method, "input": inp,
            "files": list(files or []), "device": device, "as": self.manifest["id"],
        }, max(timeout, 70) if to else timeout)

    def emit(self, name, data=None, keep=0, app=None, device=None):
        """An event for the phone's app; `keep` seconds holds it until that app is open."""
        self._request("mutation", "apps.emit", {
            "to": f'phone:{app or self.manifest["id"]}', "name": name, "data": data, "keep": keep,
            "device": device, "as": self.manifest["id"],
        })

    def phone_apps(self, device=None):
        return self._request("query", "apps.phone", {"device": device})


def _takes(fn, n):
    """Whether fn takes n positional arguments (handlers may skip `files`)."""
    try:
        params = inspect.signature(fn).parameters.values()
    except (TypeError, ValueError):
        return False
    if any(p.kind == p.VAR_POSITIONAL for p in params):
        return True
    return sum(p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD) for p in params) >= n
