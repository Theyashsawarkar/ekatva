//! One phone's connection, from the TCP accept to its end: the HTTP upgrade,
//! the rate limit, the Noise handshake, who it is (a paired phone, or a
//! pairing code waiting for a yes on the desktop), the welcome, and then each
//! message to where it goes: the session's ports, or the link's own API.

use std::net::TcpStream;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, mpsc};

use serde_json::{Map, Value, json};

use crate::api;
use crate::channel::{self, CONTROL, Incoming, PORT_LINK, Receiver, Sender, close};
use crate::crypto::{b64u, sas};
use crate::hub::{Conn, Decision, Hub, PAIR_TTL, log, now_ms};
use crate::ws::{Accepted, Writer};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn serve(hub: Arc<Hub>, stream: TcpStream) {
    let peer = stream.peer_addr().map(|a| a.ip().to_string()).unwrap_or_else(|_| "?".into());
    let (accepted, writer) = match channel::accept(stream, "ekatva") {
        Ok(x) => x,
        Err(_) => return,
    };
    let (headers, mut reader, writer) = match (accepted, writer) {
        (Accepted::Link { headers, reader }, Some(w)) => (headers, reader, w),
        (Accepted::NotFound(what), _) => {
            log(&format!("turned away {what} from {peer}: phones connect at /link"));
            return;
        }
        _ => return,
    };
    let ws = Arc::new(Writer::new(writer));
    // Only a tunnel on this laptop may say who it forwards for: from the
    // network, a header is anyone's to write (and would dodge the rate limit).
    let local = peer == "127.0.0.1" || peer == "::1" || peer == "::ffff:127.0.0.1";
    let forwarded = if local {
        headers.get("cf-connecting-ip").or_else(|| headers.get("x-forwarded-for")).cloned()
    } else {
        None
    };
    let ip = forwarded.as_deref().unwrap_or(&peer).split(',').next().unwrap_or("?").trim().to_string();
    let via: &'static str = if forwarded.is_some() { "tunnel" } else { "lan" };
    if hub.shut_out(&ip) {
        ws.close(close::SHUT_OUT, "too many attempts; try again later");
        return;
    }

    let hello = json!({"v": 1, "name": hub.cfg.name, "info": {"version": VERSION}});
    let hs = match channel::handshake(&mut reader, &ws, &hub.me.secret, &hello) {
        Ok(h) => h,
        Err(e) => {
            hub.failed(&ip);
            log(&format!("refused a connection from {ip}: {e}"));
            ws.close(close::PROTOCOL, "handshake failed");
            return;
        }
    };
    let key = b64u(&hs.remote);
    let noise = Arc::new(hs.transport);
    let sender = Arc::new(Sender::new(ws.clone(), noise.clone()));
    let name = hs.hello["name"].as_str().unwrap_or("phone").chars().take(64).collect::<String>();
    let mut info: Map<String, Value> = hs.hello.get("info").and_then(Value::as_object).cloned().unwrap_or_default();

    // Who is it?
    let decision = if let Some(token) = hs.hello.get("token").and_then(Value::as_str) {
        if !hub.redeem(token) {
            Err("this pairing code was used or has expired; show a new one".to_string())
        } else {
            info.insert("address".into(), json!(ip));
            confirm(&hub, &key, &name, sas(&hs.hash), info.clone())
        }
    } else {
        match hub.device(&key) {
            Some(d) => Ok(json!({"grants": d.grants, "name": hub.cfg.name, "session": hub.has_session()})),
            None => Err("this phone isn't paired with this laptop; scan its pairing code".to_string()),
        }
    };
    let ok = decision.is_ok();
    let frame = match &decision {
        Ok(welcome) => json!({"t": "decision", "ok": true, "welcome": welcome}),
        Err(reason) => json!({"t": "decision", "ok": false, "reason": reason}),
    };
    if sender.control(&frame).is_err() || !ok {
        if let Err(reason) = decision {
            hub.failed(&ip);
            log(&format!("refused a connection from {ip}: {reason}"));
            ws.close(close::DENIED, &reason);
        }
        return;
    }

    let last_seen = Arc::new(AtomicU64::new(now_ms() as u64));
    let id = hub.add_conn(Conn { key: key.clone(), name: name.clone(), via, info: info.clone(), sender: sender.clone(), last_seen: last_seen.clone() });
    hub.seen(&key, Some(&info));
    let label = hub.device(&key).map(|d| d.name).unwrap_or(name);
    log(&format!("{label} connected ({via})"));

    // No read timeout from here: the keepalive ends a silent phone.
    let _ = reader.set_timeout(None);
    let mut rx = Receiver::new(noise);
    let reason = loop {
        match channel::read(&mut reader, &sender, &mut rx) {
            Ok(None) => {}
            Ok(Some(msg)) => {
                last_seen.store(now_ms() as u64, Ordering::Relaxed);
                match msg {
                    Incoming::Control(c) => match c.get("t").and_then(Value::as_str) {
                        Some("ping") => {
                            let _ = sender.control(&json!({"t": "pong"}));
                        }
                        Some("pong") => {}
                        _ => hub.to_session(id, None, &[], Some(&c)),
                    },
                    Incoming::Port(PORT_LINK, data) => {
                        let (hub, sender, key) = (hub.clone(), sender.clone(), key.clone());
                        // Its own thread: a login waits for the greeter.
                        std::thread::spawn(move || api::handle(&hub, &key, &sender, &data));
                    }
                    Incoming::Port(port, data) if port != CONTROL => hub.to_session(id, Some(port), &data, None),
                    Incoming::Port(..) => {}
                }
            }
            Err(e) => break e.to_string(),
        }
    };
    hub.drop_conn(id, &reason);
    hub.seen(&key, None);
    log(&format!("{label} disconnected: {reason}"));
    ws.close(close::BYE, "bye");
}

/// Pairing waits for a yes on the desktop (the session's window shows the emoji).
fn confirm(hub: &Hub, key: &str, name: &str, sas: Vec<String>, info: Map<String, Value>) -> Result<Value, String> {
    let Some((id, rx)) = hub.ask_pairing(key, name, sas, info) else {
        return Err("pair from the laptop's desktop: nobody is logged in".into());
    };
    match rx.recv_timeout(PAIR_TTL) {
        Ok(Decision::Yes(welcome)) => {
            let mut w = welcome;
            w["session"] = json!(true);
            Ok(w)
        }
        Ok(Decision::No(reason)) => Err(reason),
        Err(mpsc::RecvTimeoutError::Timeout) => {
            hub.forget_pairing(&id);
            Err("nobody confirmed on the laptop in time".into())
        }
        Err(_) => Err("the laptop's session ended".into()),
    }
}

/// How often the keepalive looks: once per period for every phone at once.
pub fn keepalive(hub: Arc<Hub>) {
    loop {
        std::thread::sleep(crate::hub::KEEPALIVE);
        hub.keepalive();
    }
}
