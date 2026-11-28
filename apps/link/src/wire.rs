//! Messages between the link and a local client (the session's daemon, the
//! greeter) over a unix socket: `[u32 total][u32 header length][header JSON][payload]`,
//! big-endian. The header says what it is (`t`); the payload carries a port's
//! bytes as they are (no base64 for tRPC traffic).

use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::sync::Mutex;

use serde_json::Value;

/// The largest message either side sends: a port's whole message plus its header.
const MAX: usize = 17 * 1024 * 1024;

pub fn read(s: &mut UnixStream) -> io::Result<(Value, Vec<u8>)> {
    let mut len = [0u8; 4];
    s.read_exact(&mut len)?;
    let total = u32::from_be_bytes(len) as usize;
    if !(4..=MAX).contains(&total) {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "bad message length"));
    }
    let mut body = vec![0u8; total];
    s.read_exact(&mut body)?;
    let hlen = u32::from_be_bytes(body[..4].try_into().unwrap()) as usize;
    if hlen > total - 4 {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "bad header length"));
    }
    let header: Value = serde_json::from_slice(&body[4..4 + hlen])
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e.to_string()))?;
    Ok((header, body[4 + hlen..].to_vec()))
}

/// The writing side of a client's socket, shared by every thread that talks to it.
pub struct Peer {
    s: Mutex<UnixStream>,
}

impl Peer {
    pub fn new(s: UnixStream) -> Self {
        Peer { s: Mutex::new(s) }
    }

    pub fn send(&self, header: &Value, payload: &[u8]) -> io::Result<()> {
        let h = header.to_string();
        let total = 4 + h.len() + payload.len();
        let mut out = Vec::with_capacity(4 + total);
        out.extend_from_slice(&(total as u32).to_be_bytes());
        out.extend_from_slice(&(h.len() as u32).to_be_bytes());
        out.extend_from_slice(h.as_bytes());
        out.extend_from_slice(payload);
        let mut s = self.s.lock().unwrap_or_else(|e| e.into_inner());
        s.write_all(&out)
    }

    pub fn json(&self, header: &Value) -> io::Result<()> {
        self.send(header, &[])
    }

    pub fn shutdown(&self) {
        let s = self.s.lock().unwrap_or_else(|e| e.into_inner());
        let _ = s.shutdown(std::net::Shutdown::Both);
    }
}

/// The uid on the other end of a unix socket (SO_PEERCRED): who's asking.
pub fn peer_uid(s: &UnixStream) -> io::Result<u32> {
    use std::os::fd::AsRawFd;
    let mut cred = libc::ucred { pid: 0, uid: 0, gid: 0 };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: getsockopt writes at most `len` bytes into `cred`, which is that size.
    let r = unsafe {
        libc::getsockopt(
            s.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut cred as *mut libc::ucred).cast(),
            &mut len,
        )
    };
    if r != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(cred.uid)
}
