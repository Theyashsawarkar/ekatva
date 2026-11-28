//! ekatva-link: the part of ekatva that is always there. A system service
//! (user `ekatva`, from boot) holding the laptop's identity, the paired phones
//! and their link; it hands each phone's ports to the logged-in user's session
//! (session.sock) and answers the few things a phone may ask before anyone is
//! logged in (api.rs). docs/plans/link-and-session.md.
//!
//!   ekatva-link          run (state in $EKATVA_LINK_STATE or /var/lib/ekatva,
//!                        sockets in $EKATVA_LINK_RUN or /run/ekatva)
//!   ekatva-link key      print the laptop's public key (base64url)

mod api;
mod beacon;
mod channel;
mod conn;
mod crypto;
mod emoji;
mod hub;
mod mailbox;
mod session;
mod store;
mod wire;
mod ws;

use std::net::TcpListener;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use hub::{Hub, log};
use store::Store;

fn main() -> ExitCode {
    let state = PathBuf::from(std::env::var("EKATVA_LINK_STATE").unwrap_or_else(|_| "/var/lib/ekatva".into()));
    let run = PathBuf::from(std::env::var("EKATVA_LINK_RUN").unwrap_or_else(|_| "/run/ekatva".into()));
    let store = match Store::open(state.clone()) {
        Ok(s) => s,
        Err(e) => {
            log(&format!("can't open {}: {e}", state.display()));
            return ExitCode::FAILURE;
        }
    };
    let me = match store.identity() {
        Ok(k) => k,
        Err(e) => {
            log(&format!("the identity: {e}"));
            return ExitCode::FAILURE;
        }
    };
    if std::env::args().nth(1).as_deref() == Some("key") {
        println!("{}", crypto::b64u(&me.public));
        return ExitCode::SUCCESS;
    }
    let cfg = match store.config() {
        Ok(c) => c,
        Err(e) => {
            log(&format!("the settings ({}/link.json): {e}", state.display()));
            return ExitCode::FAILURE;
        }
    };
    let tcp = match TcpListener::bind((cfg.host.as_str(), cfg.port)) {
        Ok(l) => l,
        Err(e) => {
            log(&format!("can't listen on port {}: {e}", cfg.port));
            return ExitCode::FAILURE;
        }
    };
    let _ = std::fs::create_dir_all(&run);
    let (sessions, greeters) = match (session::listen(&run.join("session.sock")), session::listen(&run.join("greeter.sock"))) {
        (Ok(s), Ok(g)) => (s, g),
        (Err(e), _) | (_, Err(e)) => {
            log(&format!("can't open the sockets in {}: {e}", run.display()));
            return ExitCode::FAILURE;
        }
    };
    let hub = Hub::new(cfg.clone(), me, store);
    log(&format!(
        "ekatva-link {}: listening on port {}, {} paired device(s)",
        conn::VERSION,
        cfg.port,
        hub.devices().len()
    ));

    let h = hub.clone();
    std::thread::spawn(move || session::serve_sessions(h, sessions));
    let h = hub.clone();
    std::thread::spawn(move || session::serve_greeters(h, greeters));
    let h = hub.clone();
    std::thread::spawn(move || conn::keepalive(h));
    if cfg.advertise {
        let h = hub.clone();
        std::thread::spawn(move || beacon::run(h));
    }
    if let Some(server) = cfg.ntfy.clone() {
        let h = hub.clone();
        std::thread::spawn(move || mailbox::run(h, server));
    }
    for stream in tcp.incoming().flatten() {
        let h: Arc<Hub> = hub.clone();
        std::thread::spawn(move || conn::serve(h, stream));
    }
    ExitCode::SUCCESS
}
