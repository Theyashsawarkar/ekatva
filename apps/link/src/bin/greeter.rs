//! ekatva-greeter: greetd's greeter, so a phone can log in after a reboot.
//!
//!   greetd.toml:  command = "ekatva-greeter -- /usr/local/bin/tuigreet-launch"
//!
//! It runs the real greeter (tuigreet) as its child on the console, exactly
//! as before: typing on the laptop works the same. Beside it, it waits on
//! ekatva-link's greeter socket. When a paired phone (with the `unlock`
//! grant) asks to log in, it stops tuigreet, says so on the screen, and logs
//! in through greetd's own protocol: PAM checks the password, faillock counts,
//! the keyring opens, as for a typed login. A wrong password brings tuigreet
//! back. The password is used once, in memory, and never logged.
//!
//! Without ekatva-link (not installed, not running), it's just tuigreet.

#[path = "../wire.rs"]
#[allow(dead_code)]
mod wire;

use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::process::{Child, Command, ExitCode};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};

const LINK: &str = "/run/ekatva/greeter.sock";
const TUIGREET_CONFIG: &str = "/etc/tuigreet/config.toml";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let child_cmd: Vec<String> = match args.iter().position(|a| a == "--") {
        Some(i) => args[i + 1..].to_vec(),
        None => vec!["tuigreet".into()],
    };
    if child_cmd.is_empty() {
        eprintln!("usage: ekatva-greeter -- <greeter command>");
        return ExitCode::FAILURE;
    }
    let child = Arc::new(Mutex::new(spawn(&child_cmd)));
    // Logging in from a phone happens on this thread's side; the main thread
    // follows the child greeter.
    let c = child.clone();
    let cmd = child_cmd.clone();
    std::thread::spawn(move || follow_link(c, cmd));
    loop {
        std::thread::sleep(Duration::from_millis(250));
        let mut guard = child.lock().unwrap_or_else(|e| e.into_inner());
        let Some(ch) = guard.as_mut() else { continue };
        match ch.try_wait() {
            // tuigreet finished: someone logged in on the laptop (greetd starts
            // their session once we're gone), or it failed.
            Ok(Some(status)) => return if status.success() { ExitCode::SUCCESS } else { ExitCode::FAILURE },
            Ok(None) => {}
            Err(_) => return ExitCode::FAILURE,
        }
    }
}

fn spawn(cmd: &[String]) -> Option<Child> {
    match Command::new(&cmd[0]).args(&cmd[1..]).spawn() {
        Ok(c) => Some(c),
        Err(e) => {
            eprintln!("ekatva-greeter: can't start {}: {e}", cmd[0]);
            None
        }
    }
}

/// Connects to the link (again and again while it's away) and answers it.
fn follow_link(child: Arc<Mutex<Option<Child>>>, cmd: Vec<String>) {
    let path = std::env::var("EKATVA_GREETER_SOCKET").unwrap_or_else(|_| LINK.into());
    loop {
        if let Ok(mut s) = UnixStream::connect(&path)
            && let Ok(w) = s.try_clone()
        {
            let peer = wire::Peer::new(w);
            while let Ok((h, _)) = wire::read(&mut s) {
                if h.get("t").and_then(Value::as_str) != Some("login") {
                    continue;
                }
                let id = h.get("id").cloned().unwrap_or(Value::Null);
                let answer = login(&h, &child, &cmd);
                let done = answer.get("ok") == Some(&json!(true));
                let mut reply = answer;
                reply["t"] = json!("reply");
                reply["id"] = id;
                let _ = peer.json(&reply);
                if done {
                    // greetd starts the session once the greeter is gone.
                    std::process::exit(0);
                }
            }
        }
        std::thread::sleep(Duration::from_secs(3));
    }
}

/// One login from a phone: tuigreet out of the way, then greetd.
fn login(h: &Value, child: &Arc<Mutex<Option<Child>>>, cmd: &[String]) -> Value {
    let (Some(user), Some(password)) = (h.get("user").and_then(Value::as_str), h.get("password").and_then(Value::as_str)) else {
        return json!({"ok": false, "error": "needs a user and a password"});
    };
    let phone = h.get("phone").and_then(Value::as_str).unwrap_or("your phone");
    let Ok(sock) = std::env::var("GREETD_SOCK") else {
        return json!({"ok": false, "error": "not running under greetd"});
    };
    {
        let mut guard = child.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(mut c) = guard.take() {
            // SAFETY: kill only sends a signal to our own child.
            unsafe { libc::kill(c.id() as i32, libc::SIGTERM) };
            let _ = c.wait();
        }
    }
    // Never a surprise: the screen says who is logging in.
    print!("\x1b[2J\x1b[H\n\n    Logging in from {phone}…\n");
    let _ = io::stdout().flush();
    let result = greetd(&sock, user, password);
    match result {
        Ok(()) => json!({"ok": true}),
        Err(Failure::Wrong) => {
            *child.lock().unwrap_or_else(|e| e.into_inner()) = spawn(cmd);
            json!({"ok": false, "wrong": true})
        }
        Err(Failure::Other(e)) => {
            *child.lock().unwrap_or_else(|e| e.into_inner()) = spawn(cmd);
            json!({"ok": false, "error": e})
        }
    }
}

enum Failure {
    Wrong,
    Other(String),
}

fn send(s: &mut UnixStream, msg: &Value) -> io::Result<()> {
    let body = msg.to_string();
    s.write_all(&(body.len() as u32).to_ne_bytes())?;
    s.write_all(body.as_bytes())
}

fn recv(s: &mut UnixStream) -> io::Result<Value> {
    let mut len = [0u8; 4];
    s.read_exact(&mut len)?;
    let n = u32::from_ne_bytes(len) as usize;
    if n > 1 << 20 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "greetd: message too large"));
    }
    let mut body = vec![0u8; n];
    s.read_exact(&mut body)?;
    serde_json::from_slice(&body).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))
}

/// greetd-ipc(7): create_session, answer its questions (the secret one with
/// the password), start_session.
fn greetd(sock: &str, user: &str, password: &str) -> Result<(), Failure> {
    let io = |e: io::Error| Failure::Other(format!("greetd: {e}"));
    let mut s = UnixStream::connect(sock).map_err(io)?;
    s.set_read_timeout(Some(Duration::from_secs(30))).map_err(io)?;
    let mut r = {
        send(&mut s, &json!({"type": "create_session", "username": user})).map_err(io)?;
        recv(&mut s).map_err(io)?
    };
    // A session left half-made (tuigreet stopped mid-way): start over once.
    if r["type"] == "error" && r["error_type"] != "auth_error" {
        let _ = send(&mut s, &json!({"type": "cancel_session"}));
        let _ = recv(&mut s);
        send(&mut s, &json!({"type": "create_session", "username": user})).map_err(io)?;
        r = recv(&mut s).map_err(io)?;
    }
    let mut answered_secret = false;
    loop {
        match r["type"].as_str() {
            Some("success") => break,
            Some("auth_message") => {
                let response = match r["auth_message_type"].as_str() {
                    // One password: a second secret question (a second factor) isn't ours to answer.
                    Some("secret") if !answered_secret => {
                        answered_secret = true;
                        json!(password)
                    }
                    Some("info") | Some("error") => Value::Null,
                    _ => {
                        let _ = send(&mut s, &json!({"type": "cancel_session"}));
                        return Err(Failure::Other("the login asks for more than a password".into()));
                    }
                };
                send(&mut s, &json!({"type": "post_auth_message_response", "response": response})).map_err(io)?;
                r = recv(&mut s).map_err(io)?;
            }
            Some("error") => {
                let _ = send(&mut s, &json!({"type": "cancel_session"}));
                let _ = recv(&mut s);
                return Err(if r["error_type"] == "auth_error" {
                    Failure::Wrong
                } else {
                    Failure::Other(r["description"].as_str().unwrap_or("greetd refused").to_string())
                });
            }
            _ => return Err(Failure::Other("greetd answered something unexpected".into())),
        }
    }
    let cmd = session_command();
    send(&mut s, &json!({"type": "start_session", "cmd": ["/bin/sh", "-c", cmd], "env": []})).map_err(io)?;
    let r = recv(&mut s).map_err(io)?;
    if r["type"] == "success" {
        Ok(())
    } else {
        Err(Failure::Other(r["description"].as_str().unwrap_or("greetd couldn't start the session").to_string()))
    }
}

/// The session tuigreet would start: its config's [session] command, else sway.
fn session_command() -> String {
    let path = std::env::var("EKATVA_GREETER_SESSION_FROM").unwrap_or_else(|_| TUIGREET_CONFIG.into());
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let mut in_session = false;
    for line in text.lines() {
        let l = line.trim();
        if l.starts_with('[') {
            in_session = l == "[session]";
            continue;
        }
        if in_session
            && let Some(v) = l.strip_prefix("command").map(str::trim_start).and_then(|v| v.strip_prefix('='))
        {
            let v = v.trim();
            if let Some(inner) = v.strip_prefix('"').and_then(|v| v.strip_suffix('"')) {
                return inner.replace("\\\"", "\"");
            }
        }
    }
    "sway".into()
}

#[cfg(test)]
mod tests {
    #[test]
    fn reads_tuigreets_session_command() {
        let dir = std::env::temp_dir().join(format!("ekg-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("config.toml");
        std::fs::write(&f, "[display]\ncommand = \"no\"\n[session]\n# c\ncommand = \"systemd-cat -t sway env A=1 sway\"\n").unwrap();
        // SAFETY: single-threaded test setting its own variable.
        unsafe { std::env::set_var("EKATVA_GREETER_SESSION_FROM", &f) };
        assert_eq!(super::session_command(), "systemd-cat -t sway env A=1 sway");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
