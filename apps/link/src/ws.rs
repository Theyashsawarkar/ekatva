//! Just enough WebSocket (RFC 6455) for the link, server side: the HTTP
//! upgrade at /link, the tunnel's health check at /alive, binary messages of at
//! most one Noise message (64 KiB), ping, pong and close.
//!
//! Written here rather than with tungstenite so a connection is one blocking
//! reader thread, and anything may send through a `Writer` (a lock around the
//! socket, whole frames at a time): no polling, no split-socket races.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::TcpStream;
use std::sync::Mutex;
use std::time::Duration;

use sha1::{Digest, Sha1};

use crate::crypto::b64u_std;

/// The largest message a phone may send: one Noise message.
pub const MAX_MESSAGE: usize = 65_535;
const MAX_HEADERS: usize = 16 * 1024;
const GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// What came in: an upgraded link (with the request's headers), or nothing more to do.
pub enum Accepted {
    Link { headers: HashMap<String, String>, reader: Reader },
    Done,
    /// Something other than /link or /alive: turned away (the caller says so).
    NotFound(String),
}

/// Reads the request; answers /alive and anything that isn't /link itself.
pub fn accept(mut stream: TcpStream, alive_body: &str) -> io::Result<(Accepted, Option<TcpStream>)> {
    stream.set_read_timeout(Some(Duration::from_secs(15)))?;
    let mut buf = Vec::with_capacity(1024);
    let end = loop {
        let mut chunk = [0u8; 1024];
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Ok((Accepted::Done, None));
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(i) = find(&buf, b"\r\n\r\n") {
            break i + 4;
        }
        if buf.len() > MAX_HEADERS {
            let _ = stream.write_all(b"HTTP/1.1 431 Request Header Fields Too Large\r\nconnection: close\r\n\r\n");
            return Ok((Accepted::Done, None));
        }
    };
    let head = String::from_utf8_lossy(&buf[..end]).to_string();
    let rest = buf[end..].to_vec();
    let mut lines = head.split("\r\n");
    let request = lines.next().unwrap_or("");
    let mut parts = request.split(' ');
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("");
    let mut headers = HashMap::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    if method == "GET" && path == "/alive" {
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{alive_body}",
            alive_body.len()
        );
        return Ok((Accepted::Done, None));
    }
    let upgrade = headers.get("upgrade").is_some_and(|u| u.eq_ignore_ascii_case("websocket"));
    let key = headers.get("sec-websocket-key").cloned();
    let (true, true, Some(key)) = (method == "GET", path == "/link" && upgrade, key) else {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        let what: String = format!("{method} {path}").chars().take(120).collect();
        return Ok((Accepted::NotFound(what), None));
    };
    let accept = b64u_std(&Sha1::digest(format!("{key}{GUID}").as_bytes()));
    write!(
        stream,
        "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: {accept}\r\n\r\n"
    )?;
    let writer = stream.try_clone()?;
    Ok((Accepted::Link { headers, reader: Reader { stream, buf: rest } }, Some(writer)))
}

fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// What a read gives: a whole binary message, or the end.
pub enum Message {
    Binary(Vec<u8>),
    Ping(Vec<u8>),
    Closed(u16, String),
}

pub struct Reader {
    stream: TcpStream,
    buf: Vec<u8>,
}

impl Reader {
    pub fn set_timeout(&self, t: Option<Duration>) -> io::Result<()> {
        self.stream.set_read_timeout(t)
    }

    fn fill(&mut self, n: usize) -> io::Result<()> {
        while self.buf.len() < n {
            let mut chunk = [0u8; 16 * 1024];
            let got = self.stream.read(&mut chunk)?;
            if got == 0 {
                return Err(io::Error::new(io::ErrorKind::UnexpectedEof, "closed"));
            }
            self.buf.extend_from_slice(&chunk[..got]);
        }
        Ok(())
    }

    fn take(&mut self, n: usize) -> io::Result<Vec<u8>> {
        self.fill(n)?;
        Ok(self.buf.drain(..n).collect())
    }

    /// The next message (continuation frames joined, at most MAX_MESSAGE).
    pub fn read(&mut self) -> io::Result<Message> {
        let mut whole: Vec<u8> = Vec::new();
        let mut started = false;
        loop {
            let h = self.take(2)?;
            let fin = h[0] & 0x80 != 0;
            let op = h[0] & 0x0f;
            if h[1] & 0x80 == 0 {
                return Err(bad("a client's frame must be masked"));
            }
            let len = match h[1] & 0x7f {
                126 => u16::from_be_bytes(self.take(2)?.try_into().unwrap()) as u64,
                127 => u64::from_be_bytes(self.take(8)?.try_into().unwrap()),
                n => n as u64,
            };
            if len > MAX_MESSAGE as u64 {
                return Err(bad("frame too large"));
            }
            let mask = self.take(4)?;
            let mut data = self.take(len as usize)?;
            for (i, b) in data.iter_mut().enumerate() {
                *b ^= mask[i % 4];
            }
            match op {
                0x8 => {
                    let code = if data.len() >= 2 { u16::from_be_bytes([data[0], data[1]]) } else { 1005 };
                    let reason = String::from_utf8_lossy(data.get(2..).unwrap_or(&[])).to_string();
                    return Ok(Message::Closed(code, reason));
                }
                0x9 => return Ok(Message::Ping(data)),
                0xA => continue,
                0x1 | 0x2 if !started => {
                    started = true;
                    whole = data;
                }
                0x0 if started => whole.extend_from_slice(&data),
                _ => return Err(bad("unexpected frame")),
            }
            if whole.len() > MAX_MESSAGE {
                return Err(bad("message too large"));
            }
            if fin {
                return Ok(Message::Binary(whole));
            }
        }
    }
}

fn bad(why: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, why)
}

/// Sends whole frames; shared by everything that writes to one connection.
pub struct Writer {
    stream: Mutex<TcpStream>,
}

impl Writer {
    pub fn new(stream: TcpStream) -> Self {
        let _ = stream.set_write_timeout(Some(Duration::from_secs(30)));
        let _ = stream.set_nodelay(true);
        Writer { stream: Mutex::new(stream) }
    }

    fn frame(&self, op: u8, data: &[u8]) -> io::Result<()> {
        let mut out = Vec::with_capacity(data.len() + 10);
        out.push(0x80 | op);
        match data.len() {
            n if n < 126 => out.push(n as u8),
            n if n <= 0xffff => {
                out.push(126);
                out.extend_from_slice(&(n as u16).to_be_bytes());
            }
            n => {
                out.push(127);
                out.extend_from_slice(&(n as u64).to_be_bytes());
            }
        }
        out.extend_from_slice(data);
        let mut s = self.stream.lock().unwrap_or_else(|e| e.into_inner());
        s.write_all(&out)
    }

    pub fn binary(&self, data: &[u8]) -> io::Result<()> {
        self.frame(0x2, data)
    }

    pub fn pong(&self, data: &[u8]) -> io::Result<()> {
        self.frame(0xA, data)
    }

    /// Says goodbye and ends the socket (the reader then ends too).
    pub fn close(&self, code: u16, reason: &str) {
        let mut body = code.to_be_bytes().to_vec();
        let mut end = reason.len().min(120);
        while !reason.is_char_boundary(end) {
            end -= 1;
        }
        body.extend_from_slice(&reason.as_bytes()[..end]);
        let _ = self.frame(0x8, &body);
        let s = self.stream.lock().unwrap_or_else(|e| e.into_inner());
        let _ = s.shutdown(std::net::Shutdown::Both);
    }
}
