//! The link's shared state: the phones connected now, the session attached
//! (if anyone is logged in), the greeter (if the laptop is at the login
//! screen), the paired phones, and pairings waiting for a yes on the desktop.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Map, Value, json};

use crate::channel::{Sender, close};
use crate::crypto::{KeyPair, b64u, from_b64u, random};
use crate::store::{Config, Device, Store};
use crate::wire::Peer;

pub const PAIR_TTL: Duration = Duration::from_secs(120);
const MAX_FAILURES: u32 = 10;
const FAILURE_WINDOW: Duration = Duration::from_secs(10 * 60);
/// Pings every 20 s; a phone silent for three of them is gone.
pub const KEEPALIVE: Duration = Duration::from_secs(20);

pub fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

pub fn log(msg: &str) {
    eprintln!("{msg}");
}

/// One phone connected now.
pub struct Conn {
    pub key: String,
    pub name: String,
    pub via: &'static str,
    pub info: Map<String, Value>,
    pub sender: Arc<Sender>,
    pub last_seen: Arc<AtomicU64>,
}

/// What a pairing waits for.
pub enum Decision {
    Yes(Value),
    No(String),
}

struct Pending {
    key: String,
    name: String,
    sas: Vec<String>,
    info: Map<String, Value>,
    at: f64,
    answer: mpsc::Sender<Decision>,
}

#[derive(Default)]
struct Inner {
    devices: Vec<Device>,
    conns: HashMap<u64, Conn>,
    next: u64,
    session: Option<Arc<Peer>>,
    greeter: Option<Arc<Peer>>,
    tokens: Vec<([u8; 16], Instant)>,
    pendings: HashMap<String, Pending>,
    failures: HashMap<String, (u32, Instant)>,
    /// Answers the greeter owes (login requests), by id.
    greeter_calls: HashMap<String, mpsc::Sender<Value>>,
}

pub struct Hub {
    pub cfg: Config,
    pub me: KeyPair,
    store: Store,
    inner: Mutex<Inner>,
    started: Instant,
}

impl Hub {
    pub fn new(cfg: Config, me: KeyPair, store: Store) -> Arc<Self> {
        let devices = store.devices();
        Arc::new(Hub { cfg, me, store, inner: Mutex::new(Inner { devices, ..Default::default() }), started: Instant::now() })
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn uptime(&self) -> Duration {
        self.started.elapsed()
    }

    // ------------------------------------------------------------ devices

    pub fn device(&self, key: &str) -> Option<Device> {
        self.lock().devices.iter().find(|d| d.key == key).cloned()
    }

    pub fn devices(&self) -> Vec<Device> {
        self.lock().devices.clone()
    }

    fn save_and_tell(&self, inner: &Inner) {
        if let Err(e) = self.store.save_devices(&inner.devices) {
            log(&format!("couldn't save the paired phones: {e}"));
        }
        if let Some(s) = &inner.session {
            let _ = s.json(&json!({"t": "devices", "list": inner.devices}));
        }
    }

    pub fn put_device(&self, d: Device) {
        let mut inner = self.lock();
        match inner.devices.iter_mut().find(|x| x.key == d.key) {
            Some(x) => *x = d,
            None => inner.devices.push(d),
        }
        self.save_and_tell(&inner);
    }

    /// Forgets a phone (its connections end); the record, for an undo.
    pub fn remove_device(&self, key: &str) -> Option<Device> {
        let mut inner = self.lock();
        let i = inner.devices.iter().position(|d| d.key == key)?;
        let d = inner.devices.remove(i);
        for c in inner.conns.values().filter(|c| c.key == key) {
            c.sender.close(close::DENIED, "unpaired");
        }
        self.save_and_tell(&inner);
        Some(d)
    }

    /// Notes when a phone was last here (and what it says it is).
    pub fn seen(&self, key: &str, info: Option<&Map<String, Value>>) {
        let mut inner = self.lock();
        let Some(d) = inner.devices.iter_mut().find(|d| d.key == key) else { return };
        d.last_seen = now_ms();
        if let Some(info) = info {
            for (k, v) in info {
                d.info.insert(k.clone(), v.clone());
            }
        }
        self.save_and_tell(&inner);
    }

    // -------------------------------------------------------- connections

    pub fn add_conn(&self, c: Conn) -> u64 {
        let mut inner = self.lock();
        inner.next += 1;
        let id = inner.next;
        // A phone has one connection: a new one replaces the old.
        for old in inner.conns.values().filter(|o| o.key == c.key) {
            old.sender.close(close::BYE, "replaced by a new connection");
        }
        if let Some(s) = &inner.session {
            let _ = s.json(&json!({"t": "open", "conn": id, "key": c.key, "name": c.name, "via": c.via, "info": c.info}));
        }
        inner.conns.insert(id, c);
        id
    }

    pub fn drop_conn(&self, id: u64, reason: &str) {
        let mut inner = self.lock();
        if inner.conns.remove(&id).is_some()
            && let Some(s) = &inner.session
        {
            let _ = s.json(&json!({"t": "closed", "conn": id, "reason": reason}));
        }
    }

    pub fn conn_sender(&self, id: u64) -> Option<Arc<Sender>> {
        self.lock().conns.get(&id).map(|c| c.sender.clone())
    }

    /// Phones connected right now: (key, via).
    pub fn online(&self) -> Vec<(String, &'static str)> {
        self.lock().conns.values().map(|c| (c.key.clone(), c.via)).collect()
    }

    /// Ends every phone's connection: they reconnect into the new state
    /// (a session came or went), with a welcome that says which.
    pub fn close_all(&self, reason: &str) {
        for c in self.lock().conns.values() {
            c.sender.close(close::BYE, reason);
        }
    }

    /// From the phone, for the session: a port's message or a control message.
    pub fn to_session(&self, id: u64, port: Option<u8>, msg: &[u8], control: Option<&Value>) {
        let inner = self.lock();
        let Some(s) = &inner.session else { return };
        let _ = match (port, control) {
            (Some(p), _) => s.send(&json!({"t": "data", "conn": id, "port": p}), msg),
            (None, Some(c)) => s.json(&json!({"t": "control", "conn": id, "msg": c})),
            _ => Ok(()),
        };
    }

    /// One pass of the keepalive: ping each phone, drop the silent ones.
    pub fn keepalive(&self) {
        let limit = KEEPALIVE.as_millis() as u64 * 3;
        let now = now_ms() as u64;
        for c in self.lock().conns.values() {
            if now.saturating_sub(c.last_seen.load(Ordering::Relaxed)) > limit {
                c.sender.close(close::TIMEOUT, "timed out");
            } else {
                let _ = c.sender.control(&json!({"t": "ping"}));
            }
        }
    }

    // ------------------------------------------------- the session itself

    pub fn has_session(&self) -> bool {
        self.lock().session.is_some()
    }

    pub fn attach_session(&self, peer: Arc<Peer>) {
        let old = {
            let mut inner = self.lock();
            let hello = json!({
                "t": "hello", "v": 1, "key": b64u(&self.me.public), "name": self.cfg.name,
                "port": self.cfg.port, "url": self.cfg.url(),
            });
            let _ = peer.json(&hello);
            let _ = peer.json(&json!({"t": "devices", "list": inner.devices}));
            inner.session.replace(peer)
        };
        if let Some(old) = old {
            old.shutdown();
        }
        // Phones connected without a session reconnect into it.
        self.close_all("the laptop's session started");
    }

    pub fn detach_session(&self, peer: &Arc<Peer>) {
        let mut inner = self.lock();
        if !inner.session.as_ref().is_some_and(|s| Arc::ptr_eq(s, peer)) {
            return;
        }
        inner.session = None;
        for (_, p) in inner.pendings.drain() {
            let _ = p.answer.send(Decision::No("the laptop's session ended".into()));
        }
        drop(inner);
        self.close_all("the laptop's session ended");
    }

    // ------------------------------------------------------------ pairing

    pub fn issue_token(&self) -> String {
        let mut inner = self.lock();
        inner.tokens.retain(|(_, t)| t.elapsed() < PAIR_TTL);
        let token = random::<16>();
        inner.tokens.push((token, Instant::now()));
        b64u(&token)
    }

    /// True once per token, within its lifetime.
    pub fn redeem(&self, token: &str) -> bool {
        let Some(t) = from_b64u(token) else { return false };
        let mut inner = self.lock();
        inner.tokens.retain(|(_, at)| at.elapsed() < PAIR_TTL);
        let Some(i) = inner.tokens.iter().position(|(x, _)| x.as_slice() == t.as_slice()) else { return false };
        inner.tokens.remove(i);
        true
    }

    /// Asks the desktop to confirm a pairing; the answer comes on the receiver.
    pub fn ask_pairing(
        &self,
        key: &str,
        name: &str,
        sas: Vec<String>,
        info: Map<String, Value>,
    ) -> Option<(String, mpsc::Receiver<Decision>)> {
        let mut inner = self.lock();
        inner.session.as_ref()?;
        let (tx, rx) = mpsc::channel();
        let id = b64u(&random::<6>());
        inner.pendings.insert(id.clone(), Pending { key: key.into(), name: name.into(), sas, info, at: now_ms(), answer: tx });
        self.tell_pending(&inner);
        Some((id, rx))
    }

    pub fn forget_pairing(&self, id: &str) {
        let mut inner = self.lock();
        if inner.pendings.remove(id).is_some() {
            self.tell_pending(&inner);
        }
    }

    pub fn decide_pairing(&self, id: &str, d: Decision) -> bool {
        let mut inner = self.lock();
        let Some(p) = inner.pendings.remove(id) else { return false };
        let _ = p.answer.send(d);
        self.tell_pending(&inner);
        true
    }

    fn tell_pending(&self, inner: &Inner) {
        let list: Vec<Value> = inner
            .pendings
            .iter()
            .map(|(id, p)| json!({"id": id, "key": p.key, "name": p.name, "sas": p.sas, "info": p.info, "at": p.at}))
            .collect();
        if let Some(s) = &inner.session {
            let _ = s.json(&json!({"t": "pending", "list": list}));
        }
    }

    // ----------------------------------------------------- rate limiting

    pub fn shut_out(&self, ip: &str) -> bool {
        let mut inner = self.lock();
        match inner.failures.get(ip) {
            Some((_, since)) if since.elapsed() > FAILURE_WINDOW => {
                inner.failures.remove(ip);
                false
            }
            Some((n, _)) => *n >= MAX_FAILURES,
            None => false,
        }
    }

    pub fn failed(&self, ip: &str) {
        let mut inner = self.lock();
        let e = inner.failures.entry(ip.to_string()).or_insert((0, Instant::now()));
        if e.1.elapsed() > FAILURE_WINDOW {
            *e = (0, Instant::now());
        }
        e.0 += 1;
    }

    // ----------------------------------------------------------- greeter

    pub fn has_greeter(&self) -> bool {
        self.lock().greeter.is_some()
    }

    pub fn attach_greeter(&self, peer: Arc<Peer>) {
        if let Some(old) = self.lock().greeter.replace(peer) {
            old.shutdown();
        }
    }

    pub fn detach_greeter(&self, peer: &Arc<Peer>) {
        let mut inner = self.lock();
        if inner.greeter.as_ref().is_some_and(|g| Arc::ptr_eq(g, peer)) {
            inner.greeter = None;
            for (_, tx) in inner.greeter_calls.drain() {
                let _ = tx.send(json!({"ok": false, "error": "the login screen went away"}));
            }
        }
    }

    /// Asks the greeter (to log in); its answer, or an error after `wait`.
    pub fn ask_greeter(&self, mut msg: Value, wait: Duration) -> Value {
        let (tx, rx) = mpsc::channel();
        let id = b64u(&random::<6>());
        {
            let mut inner = self.lock();
            let Some(g) = inner.greeter.clone() else {
                return json!({"ok": false, "error": "the laptop isn't at the login screen"});
            };
            msg["id"] = json!(id);
            inner.greeter_calls.insert(id.clone(), tx);
            if g.json(&msg).is_err() {
                inner.greeter_calls.remove(&id);
                return json!({"ok": false, "error": "the login screen didn't answer"});
            }
        }
        let answer = rx.recv_timeout(wait).unwrap_or_else(|_| json!({"ok": false, "error": "the login screen didn't answer in time"}));
        self.lock().greeter_calls.remove(&id);
        answer
    }

    pub fn greeter_answered(&self, id: &str, answer: Value) {
        if let Some(tx) = self.lock().greeter_calls.remove(id) {
            let _ = tx.send(answer);
        }
    }
}
