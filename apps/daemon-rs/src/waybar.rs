//! `ekatva-rs call --waybar`: the call in progress as a waybar capsule,
//! line for line what `ekatva call --waybar` (apps/daemon/src/cli.ts) prints:
//! an empty capsule at once, one line per change of `admin.calls.watch`,
//! and the line again every 5 s while a call lasts (for its time), on the
//! same 5 s marks from the start. With no call it sleeps in a blocking read:
//! no timer wakes it (the daemon sends no keepalive PINGs). Like the
//! tRPC client there, it keeps the last call through a lost connection,
//! tries again every 2 s and subscribes again; an error from the
//! subscription clears the call and ends it.

use std::io::{ErrorKind, Write};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use serde_json::Value;
use tungstenite::client::IntoClientRequest;
use tungstenite::{Message, WebSocket};

const REDRAW: Duration = Duration::from_secs(5);
const RETRY: Duration = Duration::from_secs(2);
const SUBSCRIBE: &str = r#"{"id":1,"method":"subscription","params":{"path":"admin.calls.watch"}}"#;

/// `CallNow` (packages/protocol/src/laptop.ts).
#[derive(Deserialize, Debug, Clone)]
pub struct Call {
    pub name: String,
    pub state: String,
    #[serde(default)]
    pub number: String,
    #[serde(default)]
    pub contact: Option<String>,
    pub since: f64,
    #[serde(default)]
    pub app: Option<String>,
    #[serde(default)]
    pub video: bool,
}

/// How long a call has gone on, as the bar says it: 45s, 12m, 1h 20m (`callFor`).
pub fn call_for(ms: f64) -> String {
    let s = (ms / 1000.0).floor().max(0.0) as u64;
    if s < 60 {
        return format!("{s}s");
    }
    let m = s / 60;
    if m < 60 {
        format!("{m}m")
    } else {
        format!("{}h {}m", m / 60, m % 60)
    }
}

fn js(s: &str) -> String {
    // serde_json escapes strings as JSON.stringify does: ", \, and control characters.
    serde_json::to_string(s).unwrap_or_default()
}

/// The capsule's JSON line (`JSON.stringify` of the same object, keys in the same order).
pub fn render(call: Option<&Call>, now_ms: f64) -> String {
    let Some(c) = call else {
        return r#"{"text":"","class":"none","tooltip":""}"#.into();
    };
    let app = match c.app.as_deref().filter(|a| !a.is_empty()) {
        Some(a) => format!("{a}{} · ", if c.video { " video" } else { "" }),
        None if c.video => "video · ".into(),
        None => String::new(),
    };
    let fallback = if c.number.is_empty() {
        "Unknown"
    } else {
        &c.number
    };
    let who = format!("{app}{}", c.contact.as_deref().unwrap_or(fallback));
    let ringing = c.state == "ringing";
    let time = call_for(now_ms - c.since);
    let icon = if c.video { "" } else { "\u{f03f2}  " };
    let text = if ringing {
        format!("{icon}{who} · calling")
    } else {
        format!("{icon}{who} · {time}")
    };
    let class = match (ringing, c.video) {
        (true, true) => r#"["ringing","video"]"#,
        (true, false) => r#"["ringing"]"#,
        (false, true) => r#"["active","video"]"#,
        (false, false) => r#"["active"]"#,
    };
    let number = if c.contact.as_deref().is_some_and(|x| !x.is_empty()) && !c.number.is_empty() {
        format!(" ({})", c.number)
    } else {
        String::new()
    };
    let tooltip = format!(
        "{} {who}{number} on {}{}\nClick: open ekatva · right click: hang up",
        if ringing {
            "Incoming call from"
        } else {
            "On a call with"
        },
        c.name,
        if ringing {
            String::new()
        } else {
            format!(" · {time}")
        },
    );
    format!(
        r#"{{"text":{},"class":{class},"tooltip":{}}}"#,
        js(&text),
        js(&tooltip)
    )
}

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0)
}

fn draw(call: Option<&Call>) {
    let mut out = std::io::stdout().lock();
    if writeln!(out, "{}", render(call, now_ms()))
        .and_then(|_| out.flush())
        .is_err()
    {
        // waybar is gone.
        std::process::exit(0);
    }
}

fn connect() -> Option<WebSocket<UnixStream>> {
    let stream = UnixStream::connect(crate::paths::socket()).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    stream
        .set_write_timeout(Some(Duration::from_secs(5)))
        .ok()?;
    let req = "ws://localhost/".into_client_request().ok()?;
    let (ws, _) = tungstenite::client(req, stream).ok()?;
    Some(ws)
}

/// What a frame from the daemon means for the capsule.
enum Got {
    Nothing,
    Pong,
    Call(Option<Call>),
    /// The subscription ended (an error clears the call first).
    Ended {
        error: bool,
    },
    Reconnect,
}

fn read_frame(text: &str) -> Got {
    match text {
        "PING" => return Got::Pong,
        "PONG" => return Got::Nothing,
        _ => {}
    }
    let Ok(v) = serde_json::from_str::<Value>(text) else {
        return Got::Nothing;
    };
    if v.get("method").and_then(Value::as_str) == Some("reconnect") {
        return Got::Reconnect;
    }
    if v.get("id") != Some(&Value::from(1)) {
        return Got::Nothing;
    }
    if v.get("error").is_some() {
        return Got::Ended { error: true };
    }
    let result = &v["result"];
    match result["type"].as_str() {
        Some("data") => Got::Call(serde_json::from_value(result["data"].clone()).ok()),
        Some("stopped") => Got::Ended { error: false },
        _ => Got::Nothing,
    }
}

/// The first 5 s mark from `start` after `now`.
fn next_mark(start: Instant, now: Instant) -> Instant {
    let n = now.saturating_duration_since(start).as_millis() / REDRAW.as_millis() + 1;
    start + REDRAW * n as u32
}

pub fn run() -> ! {
    let start = Instant::now();
    let mut call: Option<Call> = None;
    // The next redraw: only while there's a call.
    let mut tick: Option<Instant> = None;
    // The subscription is wanted until the daemon ends it.
    let mut subscribed = true;
    let mut ws: Option<WebSocket<UnixStream>> = None;
    let mut retry_at = Some(Instant::now());
    draw(None);
    loop {
        let now = Instant::now();
        tick = match (&call, tick) {
            (None, _) => None,
            (Some(_), None) => Some(next_mark(start, now)),
            (Some(_), Some(t)) if now >= t => {
                draw(call.as_ref());
                Some(next_mark(start, now))
            }
            (Some(_), t) => t,
        };
        let Some(sock) = ws.as_mut() else {
            // Not connected: retry_at is set; wake for it or the next redraw.
            let at = match (retry_at, tick) {
                (Some(r), Some(t)) => r.min(t),
                (Some(r), None) => r,
                (None, Some(t)) => t,
                (None, None) => now + RETRY,
            };
            std::thread::sleep(at.saturating_duration_since(now));
            if retry_at.is_some_and(|r| Instant::now() >= r) {
                ws = connect();
                if let Some(s) = ws.as_mut()
                    && subscribed
                    && s.send(Message::text(SUBSCRIBE)).is_err()
                {
                    ws = None;
                }
                if let Some(s) = ws.as_mut() {
                    // Idle: block until the daemon says something (or goes).
                    let _ = s.get_ref().set_read_timeout(None);
                }
                retry_at = if ws.is_some() {
                    None
                } else {
                    Some(Instant::now() + RETRY)
                };
            }
            continue;
        };
        let _ = sock.get_ref().set_read_timeout(
            tick.map(|t| t.saturating_duration_since(now).max(Duration::from_millis(1))),
        );
        let lost = match sock.read() {
            Ok(Message::Text(t)) => match read_frame(t.as_str()) {
                Got::Nothing => false,
                Got::Pong => sock.send(Message::text("PONG")).is_err(),
                Got::Call(c) => {
                    call = c;
                    draw(call.as_ref());
                    false
                }
                Got::Ended { error } => {
                    subscribed = false;
                    if error {
                        call = None;
                        draw(None);
                    }
                    false
                }
                Got::Reconnect => true,
            },
            Ok(_) => false,
            Err(tungstenite::Error::Io(e))
                if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
            {
                false
            }
            Err(_) => true,
        };
        if lost {
            ws = None;
            retry_at = Some(Instant::now() + RETRY);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(json: &str) -> Call {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn times_like_the_cli() {
        assert_eq!(call_for(-5.0), "0s");
        assert_eq!(call_for(59_999.0), "59s");
        assert_eq!(call_for(60_000.0), "1m");
        assert_eq!(call_for(4_800_000.0), "1h 20m");
    }

    #[test]
    fn renders_none_ringing_and_active() {
        assert_eq!(
            render(None, 0.0),
            r#"{"text":"","class":"none","tooltip":""}"#
        );
        let ringing = call(
            r#"{"device":"d","name":"Pixel","state":"ringing","number":"+100","contact":"Asha \"A\"","since":0,"app":null,"video":false}"#,
        );
        assert_eq!(
            render(Some(&ringing), 1000.0),
            "{\"text\":\"\u{f03f2}  Asha \\\"A\\\" · calling\",\"class\":[\"ringing\"],\"tooltip\":\"Incoming call from Asha \\\"A\\\" (+100) on Pixel\\nClick: open ekatva · right click: hang up\"}"
        );
        let video = call(
            r#"{"device":"d","name":"Pixel","state":"active","number":"","contact":null,"since":0,"app":"WhatsApp","video":true}"#,
        );
        assert_eq!(
            render(Some(&video), 65_000.0),
            "{\"text\":\"WhatsApp video · Unknown · 1m\",\"class\":[\"active\",\"video\"],\"tooltip\":\"On a call with WhatsApp video · Unknown on Pixel · 1m\\nClick: open ekatva · right click: hang up\"}"
        );
    }

    #[test]
    fn marks_from_the_start() {
        let s = Instant::now();
        assert_eq!(next_mark(s, s), s + REDRAW);
        assert_eq!(next_mark(s, s + Duration::from_millis(4_999)), s + REDRAW);
        assert_eq!(next_mark(s, s + REDRAW), s + REDRAW * 2);
        assert_eq!(next_mark(s, s + Duration::from_secs(12)), s + REDRAW * 3);
    }

    #[test]
    fn reads_frames() {
        assert!(matches!(read_frame("PING"), Got::Pong));
        assert!(matches!(
            read_frame(r#"{"id":1,"result":{"type":"data","data":null}}"#),
            Got::Call(None)
        ));
        assert!(matches!(
            read_frame(r#"{"id":1,"error":{"message":"x"}}"#),
            Got::Ended { error: true }
        ));
        assert!(matches!(
            read_frame(r#"{"id":null,"method":"reconnect"}"#),
            Got::Reconnect
        ));
    }
}
