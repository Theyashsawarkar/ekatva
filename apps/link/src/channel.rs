//! The link's encrypted channel, as packages/link channel.ts: the Noise XX
//! handshake (the laptop answers), then frames `[port][flags][payload]`,
//! encrypted, with messages larger than one Noise message split and joined.
//! Port 0 is control (JSON, ping/pong); the rest carry the session's traffic
//! (1: the laptop's tRPC, 2: the phone's) and the link's own (3).

use std::collections::HashMap;
use std::io;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use snow::{Builder, StatelessTransportState};

use crate::ws::{self, Message, Reader, Writer};

pub const PROTOCOL: &str = "Noise_XX_25519_ChaChaPoly_BLAKE2b";
pub const PROLOGUE: &[u8] = b"ekatva/1";
pub const CONTROL: u8 = 0;
/// The link's own API (status, log in, reboot, power off).
pub const PORT_LINK: u8 = 3;
const HEADER: usize = 2;
const TAG: usize = 16;
const NOISE_MAX: usize = 65_535;
const CHUNK: usize = NOISE_MAX - TAG - HEADER;
const MORE: u8 = 1;
/// The largest message a port accepts once joined (as MAX_ASSEMBLED).
pub const MAX_ASSEMBLED: usize = 16 * 1024 * 1024;

/// Close codes (WebSocket's private range), as channel.ts.
pub mod close {
    pub const BYE: u16 = 4000;
    pub const DENIED: u16 = 4001;
    pub const PROTOCOL: u16 = 4003;
    pub const TIMEOUT: u16 = 4004;
    pub const SHUT_OUT: u16 = 4005;
}

/// The handshake's result: who it is, and the keys for what follows.
pub struct Handshaken {
    pub transport: StatelessTransportState,
    pub remote: [u8; 32],
    pub hash: Vec<u8>,
    /// The phone's hello: {v, name, token?, info?}.
    pub hello: Value,
}

fn proto(e: impl std::fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e.to_string())
}

fn next_binary(r: &mut Reader, w: &Writer) -> io::Result<Vec<u8>> {
    loop {
        match r.read()? {
            Message::Binary(b) => return Ok(b),
            Message::Ping(p) => w.pong(&p)?,
            Message::Closed(_, reason) => return Err(io::Error::new(io::ErrorKind::ConnectionAborted, reason)),
        }
    }
}

/// The laptop's side of XX: learn the phone's key, show ours, read its hello.
pub fn handshake(r: &mut Reader, w: &Writer, secret: &[u8; 32], hello: &Value) -> io::Result<Handshaken> {
    let mut hs = Builder::new(PROTOCOL.parse().map_err(proto)?)
        .local_private_key(secret)
        .prologue(PROLOGUE)
        .build_responder()
        .map_err(proto)?;
    let mut buf = vec![0u8; NOISE_MAX];
    hs.read_message(&next_binary(r, w)?, &mut buf).map_err(proto)?;
    let n = hs.write_message(hello.to_string().as_bytes(), &mut buf).map_err(proto)?;
    w.binary(&buf[..n])?;
    let n = hs.read_message(&next_binary(r, w)?, &mut buf).map_err(proto)?;
    let hello: Value = serde_json::from_slice(&buf[..n]).map_err(proto)?;
    if hello.get("v") != Some(&json!(1)) || !hello.get("name").is_some_and(Value::is_string) {
        return Err(proto("bad hello"));
    }
    let remote: [u8; 32] = hs
        .get_remote_static()
        .and_then(|k| k.try_into().ok())
        .ok_or_else(|| proto("no remote key"))?;
    let hash = hs.get_handshake_hash().to_vec();
    let transport = hs.into_stateless_transport_mode().map_err(proto)?;
    Ok(Handshaken { transport, remote, hash, hello })
}

/// The sending half of a channel: encrypts and writes whole messages in order.
pub struct Sender {
    ws: Arc<Writer>,
    noise: Arc<StatelessTransportState>,
    nonce: Mutex<u64>,
}

impl Sender {
    pub fn new(ws: Arc<Writer>, noise: Arc<StatelessTransportState>) -> Self {
        Sender { ws, noise, nonce: Mutex::new(0) }
    }

    /// One message on a port, split into frames as needed.
    pub fn send(&self, port: u8, data: &[u8]) -> io::Result<()> {
        if data.len() > MAX_ASSEMBLED {
            return Err(proto("message too large"));
        }
        // The nonce lock is held through the write: frames go out in nonce order.
        let mut nonce = self.nonce.lock().unwrap_or_else(|e| e.into_inner());
        let mut off = 0;
        let mut out = vec![0u8; NOISE_MAX];
        loop {
            let piece = &data[off..(off + CHUNK).min(data.len())];
            off += piece.len();
            let mut frame = Vec::with_capacity(HEADER + piece.len());
            frame.push(port);
            frame.push(if off < data.len() { MORE } else { 0 });
            frame.extend_from_slice(piece);
            let n = self.noise.write_message(*nonce, &frame, &mut out).map_err(proto)?;
            *nonce += 1;
            self.ws.binary(&out[..n])?;
            if off >= data.len() {
                return Ok(());
            }
        }
    }

    pub fn control(&self, msg: &Value) -> io::Result<()> {
        self.send(CONTROL, msg.to_string().as_bytes())
    }

    pub fn close(&self, code: u16, reason: &str) {
        self.ws.close(code, reason);
    }

    pub fn pong(&self, data: &[u8]) -> io::Result<()> {
        self.ws.pong(data)
    }
}

/// What a received message is.
pub enum Incoming {
    Control(Value),
    Port(u8, Vec<u8>),
}

/// The receiving half: decrypts frames in order and joins split messages.
pub struct Receiver {
    noise: Arc<StatelessTransportState>,
    nonce: u64,
    partial: HashMap<u8, Vec<u8>>,
}

impl Receiver {
    pub fn new(noise: Arc<StatelessTransportState>) -> Self {
        Receiver { noise, nonce: 0, partial: HashMap::new() }
    }

    /// A whole message once its last frame is in; None while one is still arriving.
    pub fn receive(&mut self, data: &[u8]) -> io::Result<Option<Incoming>> {
        let mut frame = vec![0u8; data.len()];
        // A frame that doesn't decrypt: tampering or a lost frame; the nonces
        // are out of step for good, so the session can't go on.
        let n = self.noise.read_message(self.nonce, data, &mut frame).map_err(|_| proto("bad frame"))?;
        self.nonce += 1;
        if n < HEADER {
            return Err(proto("bad frame"));
        }
        let port = frame[0];
        let more = frame[1] & MORE != 0;
        let part = self.partial.entry(port).or_default();
        if part.len() + (n - HEADER) > MAX_ASSEMBLED {
            return Err(proto("message too large"));
        }
        part.extend_from_slice(&frame[HEADER..n]);
        if more {
            return Ok(None);
        }
        let whole = self.partial.remove(&port).unwrap_or_default();
        if port == CONTROL {
            let msg: Value = serde_json::from_slice(&whole).map_err(|_| proto("bad control message"))?;
            return Ok(Some(Incoming::Control(msg)));
        }
        Ok(Some(Incoming::Port(port, whole)))
    }
}

/// Reads the next message from the phone, answering WebSocket pings.
pub fn read(r: &mut Reader, s: &Sender, rx: &mut Receiver) -> io::Result<Option<Incoming>> {
    match r.read()? {
        Message::Binary(b) => rx.receive(&b),
        Message::Ping(p) => {
            s.pong(&p)?;
            Ok(None)
        }
        Message::Closed(code, reason) => Err(io::Error::new(
            io::ErrorKind::ConnectionAborted,
            if reason.is_empty() { format!("closed ({code})") } else { reason },
        )),
    }
}

/// Re-exported for main: accept a connection's HTTP request.
pub use ws::accept;
