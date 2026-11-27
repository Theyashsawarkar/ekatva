#!/usr/bin/env python3
"""A fake MPRIS player on the session bus: org.mpris.MediaPlayer2.fakeplayer.
Plays a made-up track; every PERIOD seconds (argv[1], 0 = never) it changes
track. Control: Play/Pause/PlayPause/Next/Seek/SetPosition like a real one."""
import sys, time
from gi.repository import Gio, GLib

NAME = "org.mpris.MediaPlayer2." + (sys.argv[2] if len(sys.argv) > 2 else "fakeplayer")
PERIOD = float(sys.argv[1]) if len(sys.argv) > 1 else 0
XML = """
<node>
 <interface name="org.mpris.MediaPlayer2">
  <method name="Raise"/><method name="Quit"/>
  <property name="Identity" type="s" access="read"/>
  <property name="CanQuit" type="b" access="read"/><property name="CanRaise" type="b" access="read"/>
  <property name="HasTrackList" type="b" access="read"/>
  <property name="SupportedUriSchemes" type="as" access="read"/><property name="SupportedMimeTypes" type="as" access="read"/>
 </interface>
 <interface name="org.mpris.MediaPlayer2.Player">
  <method name="Next"/><method name="Previous"/><method name="Pause"/><method name="PlayPause"/>
  <method name="Stop"/><method name="Play"/>
  <method name="Seek"><arg direction="in" name="Offset" type="x"/></method>
  <method name="SetPosition"><arg direction="in" name="TrackId" type="o"/><arg direction="in" name="Position" type="x"/></method>
  <method name="OpenUri"><arg direction="in" name="Uri" type="s"/></method>
  <signal name="Seeked"><arg name="Position" type="x"/></signal>
  <property name="PlaybackStatus" type="s" access="read"/>
  <property name="Rate" type="d" access="readwrite"/>
  <property name="Metadata" type="a{sv}" access="read"/>
  <property name="Volume" type="d" access="readwrite"/>
  <property name="Position" type="x" access="read"/>
  <property name="MinimumRate" type="d" access="read"/><property name="MaximumRate" type="d" access="read"/>
  <property name="CanGoNext" type="b" access="read"/><property name="CanGoPrevious" type="b" access="read"/>
  <property name="CanPlay" type="b" access="read"/><property name="CanPause" type="b" access="read"/>
  <property name="CanSeek" type="b" access="read"/><property name="CanControl" type="b" access="read"/>
 </interface>
</node>"""
TRACKS = [("Made-up Song One", "Example Band"), ("Made-up Song Two", "Another Example")]
st = {"status": "Playing", "track": 0, "pos0": 0, "t0": time.monotonic()}

def pos():
    p = st["pos0"]
    if st["status"] == "Playing":
        p += int((time.monotonic() - st["t0"]) * 1e6)
    return p

def meta():
    t, a = TRACKS[st["track"] % len(TRACKS)]
    return {"mpris:trackid": GLib.Variant("o", "/track/%d" % st["track"]), "xesam:title": GLib.Variant("s", t),
            "xesam:artist": GLib.Variant("as", [a]), "mpris:length": GLib.Variant("x", 240_000_000)}

conn = None
def changed(props):
    conn.emit_signal(None, "/org/mpris/MediaPlayer2", "org.freedesktop.DBus.Properties", "PropertiesChanged",
                     GLib.Variant("(sa{sv}as)", ("org.mpris.MediaPlayer2.Player", props, [])))

def set_status(s):
    st["pos0"] = pos(); st["t0"] = time.monotonic(); st["status"] = s
    changed({"PlaybackStatus": GLib.Variant("s", s)})

def next_track():
    st["track"] += 1; st["pos0"] = 0; st["t0"] = time.monotonic()
    changed({"Metadata": GLib.Variant("a{sv}", meta())})
    return True

def method(c, sender, path, iface, name, params, inv):
    if name == "Play": set_status("Playing")
    elif name == "Pause": set_status("Paused")
    elif name == "PlayPause": set_status("Paused" if st["status"] == "Playing" else "Playing")
    elif name == "Stop": set_status("Stopped")
    elif name in ("Next", "Previous"): next_track()
    elif name in ("Seek", "SetPosition"):
        v = params.unpack()
        st["pos0"] = (pos() + v[0]) if name == "Seek" else v[1]; st["t0"] = time.monotonic()
        c.emit_signal(None, "/org/mpris/MediaPlayer2", "org.mpris.MediaPlayer2.Player", "Seeked", GLib.Variant("(x)", (st["pos0"],)))
    inv.return_value(None)

def getp(c, sender, path, iface, name):
    vals = {"Identity": GLib.Variant("s", "Fake Player"), "CanQuit": GLib.Variant("b", False), "CanRaise": GLib.Variant("b", False),
            "HasTrackList": GLib.Variant("b", False), "SupportedUriSchemes": GLib.Variant("as", []), "SupportedMimeTypes": GLib.Variant("as", []),
            "PlaybackStatus": GLib.Variant("s", st["status"]), "Rate": GLib.Variant("d", 1.0), "Metadata": GLib.Variant("a{sv}", meta()),
            "Volume": GLib.Variant("d", 1.0), "Position": GLib.Variant("x", pos()), "MinimumRate": GLib.Variant("d", 1.0),
            "MaximumRate": GLib.Variant("d", 1.0)}
    return vals.get(name, GLib.Variant("b", True))

def on_bus(c, name):
    global conn
    conn = c
    for i in Gio.DBusNodeInfo.new_for_xml(XML).interfaces:
        c.register_object("/org/mpris/MediaPlayer2", i, method, getp, None)

def on_name(c, name):
    print("ready", flush=True)
    if PERIOD > 0: GLib.timeout_add(int(PERIOD * 1000), next_track)

Gio.bus_own_name(Gio.BusType.SESSION, NAME, Gio.BusNameOwnerFlags.NONE, on_bus, on_name, None)
GLib.MainLoop().run()
