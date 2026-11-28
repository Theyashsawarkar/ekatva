//! The two local sockets (in /run/ekatva): `session.sock`, where the logged-in
//! user's daemon attaches and gets its phones' ports, and `greeter.sock`, where
//! ekatva-greeter waits at the login screen. Each checks who's on the other end
//! (SO_PEERCRED) before anything else: only the owner's uid for the session,
//! only greetd's greeter for the greeter.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::sync::Arc;

use serde_json::{Value, json};

use crate::channel::close;
use crate::hub::{Decision, Hub, log};
use crate::store::Device;
use crate::wire::{self, Peer, peer_uid};

/// Opens a socket anyone may connect to; who may stay is checked per connection.
pub fn listen(path: &Path) -> std::io::Result<UnixListener> {
    let _ = fs::remove_file(path);
    let l = UnixListener::bind(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o666))?;
    Ok(l)
}

pub fn serve_sessions(hub: Arc<Hub>, l: UnixListener) {
    for s in l.incoming().flatten() {
        let hub = hub.clone();
        std::thread::spawn(move || session(hub, s));
    }
}

pub fn serve_greeters(hub: Arc<Hub>, l: UnixListener) {
    for s in l.incoming().flatten() {
        let hub = hub.clone();
        std::thread::spawn(move || greeter(hub, s));
    }
}

fn session(hub: Arc<Hub>, mut s: UnixStream) {
    match peer_uid(&s) {
        Ok(uid) if uid == hub.cfg.owner => {}
        Ok(uid) => {
            log(&format!("refused a session from uid {uid}: only uid {} may attach", hub.cfg.owner));
            return;
        }
        Err(_) => return,
    }
    let Ok(w) = s.try_clone() else { return };
    let peer = Arc::new(Peer::new(w));
    hub.attach_session(peer.clone());
    log("the session attached");
    while let Ok((h, payload)) = wire::read(&mut s) {
        let conn = h.get("conn").and_then(Value::as_u64);
        match (h.get("t").and_then(Value::as_str), conn) {
            (Some("data"), Some(id)) => {
                let port = h.get("port").and_then(Value::as_u64).unwrap_or(0);
                if let (Some(tx), 1..=255) = (hub.conn_sender(id), port) {
                    let _ = tx.send(port as u8, &payload);
                }
            }
            (Some("control"), Some(id)) => {
                if let (Some(tx), Some(msg)) = (hub.conn_sender(id), h.get("msg")) {
                    let _ = tx.control(msg);
                }
            }
            (Some("close"), Some(id)) => {
                if let Some(tx) = hub.conn_sender(id) {
                    let reason = h.get("reason").and_then(Value::as_str).unwrap_or("bye");
                    let code = h.get("code").and_then(Value::as_u64).map(|c| c as u16).unwrap_or(close::BYE);
                    tx.close(code, reason);
                }
            }
            (Some("call"), _) => {
                let id = h.get("id").cloned().unwrap_or(Value::Null);
                let reply = match call(&hub, h.get("m").and_then(Value::as_str).unwrap_or(""), h.get("p").unwrap_or(&Value::Null)) {
                    Ok(v) => json!({"t": "reply", "id": id, "ok": true, "value": v}),
                    Err(e) => json!({"t": "reply", "id": id, "ok": false, "error": e}),
                };
                let _ = peer.json(&reply);
            }
            _ => {}
        }
    }
    hub.detach_session(&peer);
    log("the session went away");
}

/// What the session asks of the link.
fn call(hub: &Hub, method: &str, p: &Value) -> Result<Value, String> {
    match method {
        "devices.list" => Ok(json!(hub.devices())),
        "devices.put" => {
            let d: Device = serde_json::from_value(p.get("record").cloned().unwrap_or_default()).map_err(|e| e.to_string())?;
            hub.put_device(d);
            Ok(Value::Null)
        }
        "devices.remove" => {
            let key = p.get("key").and_then(Value::as_str).ok_or("needs a key")?;
            Ok(json!(hub.remove_device(key)))
        }
        "online" => Ok(json!(hub.online().into_iter().map(|(k, v)| json!({"key": k, "via": v})).collect::<Vec<_>>())),
        "pair.token" => Ok(json!({"token": hub.issue_token()})),
        "pair.decide" => {
            let id = p.get("id").and_then(Value::as_str).ok_or("needs an id")?;
            let d = if p.get("ok") == Some(&json!(true)) {
                Decision::Yes(p.get("welcome").cloned().unwrap_or(json!({})))
            } else {
                Decision::No(p.get("reason").and_then(Value::as_str).unwrap_or("refused on the laptop").to_string())
            };
            if hub.decide_pairing(id, d) { Ok(Value::Null) } else { Err("that request has gone (it timed out or was answered)".into()) }
        }
        _ => Err(format!("no such call: {method}")),
    }
}

fn greeter(hub: Arc<Hub>, mut s: UnixStream) {
    match (peer_uid(&s), hub.cfg.greeter) {
        (Ok(uid), Some(g)) if uid == g => {}
        (Ok(uid), _) => {
            log(&format!("refused a greeter from uid {uid}"));
            return;
        }
        _ => return,
    }
    let Ok(w) = s.try_clone() else { return };
    let peer = Arc::new(Peer::new(w));
    hub.attach_greeter(peer.clone());
    log("the login screen is up");
    while let Ok((h, _)) = wire::read(&mut s) {
        if h.get("t").and_then(Value::as_str) == Some("reply")
            && let Some(id) = h.get("id").and_then(Value::as_str).map(str::to_string)
        {
            hub.greeter_answered(&id, h);
        }
    }
    hub.detach_greeter(&peer);
    log("the login screen went away");
}
