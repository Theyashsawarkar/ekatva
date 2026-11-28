//! The link's own API, on port 3: what a phone may ask even when nobody is
//! logged in. Requests are `{"id", "m", "p"}`, answers `{"id", "ok", "v"}` or
//! `{"id", "ok": false, "e", "code"}`. Each method needs its capability, from the
//! phone's grants in the link's devices.json:
//!
//!   status            status   powered on, at the login screen or logged in, battery
//!   login {password}  unlock   log in at the login screen (through ekatva-greeter)
//!   reboot, poweroff  power    through logind (a polkit rule allows the `ekatva` user)
//!
//! The password is used once, in memory, and never logged.

use std::ffi::CStr;
use std::fs;
use std::process::Command;
use std::time::Duration;

use serde_json::{Value, json};

use crate::channel::{PORT_LINK, Sender};
use crate::hub::{Hub, log};

pub fn handle(hub: &Hub, key: &str, out: &Sender, data: &[u8]) {
    let Ok(req) = serde_json::from_slice::<Value>(data) else { return };
    let id = req.get("id").cloned().unwrap_or(Value::Null);
    let method = req.get("m").and_then(Value::as_str).unwrap_or("");
    let answer = match answer(hub, key, method, req.get("p").unwrap_or(&Value::Null)) {
        Ok(v) => json!({"id": id, "ok": true, "v": v}),
        Err((code, e)) => json!({"id": id, "ok": false, "code": code, "e": e}),
    };
    let _ = out.send(PORT_LINK, answer.to_string().as_bytes());
}

type Failure = (&'static str, String);

fn need(hub: &Hub, key: &str, cap: &str) -> Result<String, Failure> {
    match hub.device(key) {
        Some(d) if d.may(cap) => Ok(d.name),
        Some(_) => Err(("FORBIDDEN", format!("this device may not use \"{cap}\""))),
        None => Err(("FORBIDDEN", "not paired".into())),
    }
}

fn answer(hub: &Hub, key: &str, method: &str, p: &Value) -> Result<Value, Failure> {
    match method {
        "status" => {
            need(hub, key, "status")?;
            Ok(json!({
                "name": hub.cfg.name,
                "session": hub.has_session(),
                "loginScreen": hub.has_greeter(),
                "battery": battery(),
                "uptime": hub.uptime().as_secs(),
            }))
        }
        "login" => {
            let phone = need(hub, key, "unlock")?;
            let password = p.get("password").and_then(Value::as_str).filter(|s| !s.is_empty() && s.len() <= 1024);
            let Some(password) = password else { return Err(("BAD_REQUEST", "needs the password".into())) };
            if hub.has_session() {
                return Err(("PRECONDITION_FAILED", "someone is already logged in".into()));
            }
            let Some(user) = user_name(hub.cfg.owner) else {
                return Err(("INTERNAL_SERVER_ERROR", "no such user".into()));
            };
            log(&format!("{phone} is logging in as {user}"));
            let r = hub.ask_greeter(json!({"t": "login", "user": user, "password": password, "phone": phone}), Duration::from_secs(40));
            if r.get("ok") == Some(&json!(true)) {
                Ok(Value::Null)
            } else if r.get("wrong") == Some(&json!(true)) {
                Err(("UNAUTHORIZED", "the password was wrong".into()))
            } else {
                Err(("PRECONDITION_FAILED", r.get("error").and_then(Value::as_str).unwrap_or("couldn't log in").to_string()))
            }
        }
        "reboot" | "poweroff" => {
            let phone = need(hub, key, "power")?;
            log(&format!("{phone} asked to {method}"));
            let verb = if method == "reboot" { "reboot" } else { "poweroff" };
            // A moment later: the answer reaches the phone first.
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(800));
                match Command::new("systemctl").arg(verb).status() {
                    Ok(s) if s.success() => {}
                    other => log(&format!("systemctl {verb} failed: {other:?}")),
                }
            });
            Ok(Value::Null)
        }
        _ => Err(("NOT_FOUND", format!("no such request: {method}"))),
    }
}

fn battery() -> Value {
    for name in ["BAT0", "BAT1", "BAT"] {
        let d = format!("/sys/class/power_supply/{name}");
        let Ok(cap) = fs::read_to_string(format!("{d}/capacity")) else { continue };
        let status = fs::read_to_string(format!("{d}/status")).unwrap_or_default();
        return json!({"percent": cap.trim().parse::<u32>().unwrap_or(0), "charging": status.trim() == "Charging"});
    }
    Value::Null
}

/// The user's login name, for greetd.
pub fn user_name(uid: u32) -> Option<String> {
    // SAFETY: getpwuid returns null or a pointer to static data, read at once.
    unsafe {
        let pw = libc::getpwuid(uid);
        if pw.is_null() {
            return None;
        }
        CStr::from_ptr((*pw).pw_name).to_str().ok().map(str::to_string)
    }
}
