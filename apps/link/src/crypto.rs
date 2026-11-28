//! The small crypto the link needs beside Noise, byte for byte as
//! packages/link does it: base64url, the static keys, the pairing emoji, the
//! LAN beacon's key and seal, and the mailbox's topic, key and seal.

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use blake2::Blake2bVar;
use blake2::digest::{Update, VariableOutput};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use x25519_dalek::{PublicKey, StaticSecret};

use crate::emoji::EMOJI;

pub fn b64u(bytes: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(bytes)
}

/// Standard, padded base64 (the WebSocket handshake's).
pub fn b64u_std(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Accepts padded or unpadded base64url, as @ekatva/link's fromB64u does.
pub fn from_b64u(text: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(text.trim().trim_end_matches('=')).ok()
}

pub fn random<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::getrandom(&mut out).expect("the system's random source");
    out
}

/// BLAKE2b with an output length of `N` (BLAKE2's parameter, as noble's
/// `dkLen`: not a 64-byte hash cut short).
pub fn blake2b<const N: usize>(parts: &[&[u8]]) -> [u8; N] {
    let mut h = Blake2bVar::new(N).expect("a BLAKE2b output length");
    for p in parts {
        h.update(p);
    }
    let mut out = [0u8; N];
    h.finalize_variable(&mut out).expect("the length asked for");
    out
}

#[derive(Clone)]
pub struct KeyPair {
    pub secret: [u8; 32],
    pub public: [u8; 32],
}

impl KeyPair {
    pub fn from_secret(secret: [u8; 32]) -> Self {
        let public = PublicKey::from(&StaticSecret::from(secret)).to_bytes();
        KeyPair { secret, public }
    }

    pub fn generate() -> Self {
        Self::from_secret(random::<32>())
    }

    /// X25519 with the other side's static key (raw, as noble's getSharedSecret).
    pub fn shared(&self, other: &[u8; 32]) -> [u8; 32] {
        StaticSecret::from(self.secret)
            .diffie_hellman(&PublicKey::from(*other))
            .to_bytes()
    }
}

/// Four emoji (24 bits) for a session's handshake hash: what both screens show when pairing.
pub fn sas(handshake_hash: &[u8]) -> Vec<String> {
    let d: [u8; 32] = blake2b(&[b"ekatva/sas/1", handshake_hash]);
    let n = (u32::from(d[0]) << 16) | (u32::from(d[1]) << 8) | u32::from(d[2]);
    [18, 12, 6, 0]
        .iter()
        .map(|s| EMOJI[((n >> s) & 63) as usize].to_string())
        .collect()
}

fn seal(key: &[u8; 32], ad: &[u8], plain: &[u8]) -> Vec<u8> {
    let nonce = random::<12>();
    let boxed = ChaCha20Poly1305::new(key.into())
        .encrypt(Nonce::from_slice(&nonce), Payload { msg: plain, aad: ad })
        .expect("sealing never fails");
    [nonce.as_slice(), &boxed].concat()
}

fn open(key: &[u8; 32], ad: &[u8], data: &[u8]) -> Option<Vec<u8>> {
    if data.len() < 12 + 16 {
        return None;
    }
    ChaCha20Poly1305::new(key.into())
        .decrypt(Nonce::from_slice(&data[..12]), Payload { msg: &data[12..], aad: ad })
        .ok()
}

/// The pair's beacon key (packages/link beacon.ts).
pub fn beacon_key(me: &KeyPair, other: &[u8; 32]) -> [u8; 32] {
    blake2b(&[b"ekatva/beacon/key", &me.shared(other)])
}

/// A beacon: "your laptop is here, at this port", sealed for one phone (36 bytes).
pub fn seal_beacon(key: &[u8; 32], at_ms: f64, port: u16) -> Vec<u8> {
    let mut plain = [0u8; 10];
    plain[..8].copy_from_slice(&at_ms.to_be_bytes());
    plain[8..].copy_from_slice(&port.to_be_bytes());
    seal(key, b"ekatva/beacon/1", &plain)
}

/// A pair's mailbox on ntfy (packages/link rendezvous.ts): its topic and key.
pub struct Mailbox {
    pub topic: String,
    key: [u8; 32],
}

impl Mailbox {
    pub fn new(me: &KeyPair, other: &[u8; 32]) -> Self {
        let shared = me.shared(other);
        let topic: [u8; 18] = blake2b(&[b"ekatva/rv/topic", &shared]);
        Mailbox {
            topic: format!("ekatva-{}", b64u(&topic)),
            key: blake2b(&[b"ekatva/rv/key", &shared]),
        }
    }

    pub fn seal(&self, msg: &serde_json::Value) -> String {
        b64u(&seal(&self.key, b"ekatva/rv/1", msg.to_string().as_bytes()))
    }

    /// The message, if it's this pair's and undamaged (the caller checks its age).
    pub fn open(&self, text: &str) -> Option<serde_json::Value> {
        let plain = open(&self.key, b"ekatva/rv/1", &from_b64u(text)?)?;
        serde_json::from_slice(&plain).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn b64u_round_trips_and_takes_padding() {
        let b = [0xfbu8, 0xff, 0x00, 0x10];
        assert_eq!(b64u(&b), "-_8AEA");
        assert_eq!(from_b64u("-_8AEA==").unwrap(), b);
    }

    #[test]
    fn shared_secrets_agree() {
        let a = KeyPair::generate();
        let b = KeyPair::generate();
        assert_eq!(a.shared(&b.public), b.shared(&a.public));
        assert_eq!(beacon_key(&a, &b.public), beacon_key(&b, &a.public));
        assert_eq!(Mailbox::new(&a, &b.public).topic, Mailbox::new(&b, &a.public).topic);
    }

    #[test]
    fn mailbox_seals_and_opens() {
        let a = KeyPair::generate();
        let b = KeyPair::generate();
        let msg = serde_json::json!({"t": "where", "at": 1.0, "n": "x"});
        let text = Mailbox::new(&a, &b.public).seal(&msg);
        assert_eq!(Mailbox::new(&b, &a.public).open(&text), Some(msg));
        assert_eq!(Mailbox::new(&b, &KeyPair::generate().public).open(&text), None);
    }
}
