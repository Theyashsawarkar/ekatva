//! `ekatva-rs mcp`: an agent's MCP session, served by the daemon. Connects
//! to its MCP socket, says which agent this is (`{"agent":…}` and a
//! newline, from `$EKATVA_AGENT`), then copies newline-framed JSON-RPC
//! between stdio and the socket.
//!
//! It outlives a daemon restart (an update restarts the service): requests
//! the old daemon didn't answer get an error, the pipe reconnects, replays
//! the session's `initialize` (its answer swallowed) and `initialized`, and
//! goes on; what comes meanwhile waits in a short queue. It ends only when
//! stdin does. With no MCP socket at startup it runs `ekatva mcp` instead
//! (the TypeScript server, over the CLI's socket).

use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::Shutdown;
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

/// What the agent is told about a request the old daemon took with it.
pub const RESTARTED: &str = "ekatva daemon restarted; try again";
/// Requests waiting for the daemon, at most.
const QUEUE: usize = 64;
const FIRST_DELAY: Duration = Duration::from_millis(100);
const MAX_DELAY: Duration = Duration::from_secs(2);
/// How long to keep trying before answering what waits with an error.
const GIVE_UP: Duration = Duration::from_secs(60);
/// The id a replayed `initialize` carries: its answer is the pipe's own.
const REINIT: &str = "pipe-reinit-";

pub enum Event {
    /// A line from the agent.
    In(Vec<u8>),
    InEnd,
    /// A line from connection `n`.
    Sock(u64, Vec<u8>),
    SockEnd(u64),
}

pub fn run(args: &[OsString]) -> ! {
    let agent = std::env::var("EKATVA_AGENT")
        .ok()
        .filter(|a| !a.is_empty())
        .unwrap_or_else(|| "agent".into());
    let path = crate::paths::mcp_socket();
    let preamble = format!("{}\n", json!({ "agent": agent }));
    let (tx, rx) = mpsc::channel();
    let mut pipe = Pipe::new(path, preamble, tx.clone(), Box::new(std::io::stdout()));
    // Only at startup: an older daemon (or none yet) gets the TypeScript server.
    if pipe.connect().is_err() {
        crate::exec_ts(args);
    }
    let tx_in = tx.clone();
    thread::spawn(move || {
        read_lines(
            std::io::stdin().lock(),
            |l| tx_in.send(Event::In(l)).is_ok(),
            || {
                let _ = tx.send(Event::InEnd);
            },
        )
    });
    let code = pipe.serve(&rx);
    std::process::exit(code);
}

/// Calls `line` for each line (without its newline) until it says stop, then `end`.
fn read_lines<R: Read>(r: R, mut line: impl FnMut(Vec<u8>) -> bool, end: impl FnOnce()) {
    let mut r = BufReader::new(r);
    loop {
        let mut buf = Vec::new();
        match r.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                if buf.last() == Some(&b'\n') {
                    buf.pop();
                }
                if buf.last() == Some(&b'\r') {
                    buf.pop();
                }
                if buf.iter().all(u8::is_ascii_whitespace) {
                    continue;
                }
                if !line(buf) {
                    return;
                }
            }
        }
    }
    end();
}

struct Retry {
    since: Instant,
    delay: Duration,
    next: Instant,
}

pub struct Pipe {
    path: PathBuf,
    preamble: String,
    tx: Sender<Event>,
    out: Box<dyn Write + Send>,
    /// The connection now, and its number.
    conn: Option<UnixStream>,
    n: u64,
    /// The session's `initialize` and `initialized`, as forwarded.
    init: Option<Value>,
    initialized: Option<Vec<u8>>,
    reinits: u64,
    /// Ids of requests forwarded and not yet answered.
    pending: Vec<Value>,
    queue: VecDeque<Vec<u8>>,
    retry: Option<Retry>,
    stdin_done: bool,
}

/// A request's id (it has a method and an id), else None.
fn request_id(v: &Value) -> Option<&Value> {
    if v.get("method").is_some() {
        v.get("id")
    } else {
        None
    }
}

fn method(v: &Value) -> Option<&str> {
    v.get("method").and_then(Value::as_str)
}

impl Pipe {
    pub fn new(
        path: PathBuf,
        preamble: String,
        tx: Sender<Event>,
        out: Box<dyn Write + Send>,
    ) -> Pipe {
        Pipe {
            path,
            preamble,
            tx,
            out,
            conn: None,
            n: 0,
            init: None,
            initialized: None,
            reinits: 0,
            pending: Vec::new(),
            queue: VecDeque::new(),
            retry: None,
            stdin_done: false,
        }
    }

    /// Connects, says who we are, replays the session (on a reconnect), and starts reading.
    fn connect(&mut self) -> std::io::Result<()> {
        let mut s = UnixStream::connect(&self.path)?;
        let mut hello = self.preamble.clone().into_bytes();
        if let Some(init) = &self.init {
            self.reinits += 1;
            let mut again = init.clone();
            again["id"] = Value::String(format!("{REINIT}{}", self.reinits));
            hello.extend_from_slice(again.to_string().as_bytes());
            hello.push(b'\n');
            if let Some(done) = &self.initialized {
                hello.extend_from_slice(done);
                hello.push(b'\n');
            }
        }
        s.write_all(&hello)?;
        let reader = s.try_clone()?;
        self.n += 1;
        let (n, tx, tx_end) = (self.n, self.tx.clone(), self.tx.clone());
        thread::spawn(move || {
            read_lines(
                reader,
                |l| tx.send(Event::Sock(n, l)).is_ok(),
                || {
                    let _ = tx_end.send(Event::SockEnd(n));
                },
            )
        });
        self.conn = Some(s);
        self.retry = None;
        while let Some(line) = self.queue.pop_front() {
            if let Err(line) = self.forward(line) {
                self.queue.push_front(line);
                break;
            }
        }
        Ok(())
    }

    /// Writes a line to the daemon; gives it back if it couldn't.
    fn forward(&mut self, line: Vec<u8>) -> Result<(), Vec<u8>> {
        let Some(s) = self.conn.as_mut() else {
            return Err(line);
        };
        let mut framed = line.clone();
        framed.push(b'\n');
        if s.write_all(&framed).is_err() {
            // The reader sees it end too, and the pipe reconnects then.
            let _ = s.shutdown(Shutdown::Both);
            return Err(line);
        }
        if let Ok(v) = serde_json::from_slice::<Value>(&line) {
            if let Some(id) = request_id(&v) {
                self.pending.push(id.clone());
            }
            match method(&v) {
                Some("initialize") => self.init = Some(v),
                Some("notifications/initialized") => self.initialized = Some(line),
                _ => {}
            }
        }
        Ok(())
    }

    fn emit(&mut self, line: &[u8]) {
        let ok = self
            .out
            .write_all(line)
            .and_then(|_| self.out.write_all(b"\n"))
            .and_then(|_| self.out.flush());
        if ok.is_err() {
            // The agent is gone.
            std::process::exit(0);
        }
    }

    fn fail(&mut self, id: Value) {
        let e = json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32000, "message": RESTARTED } });
        self.emit(e.to_string().as_bytes());
    }

    /// Answers a line that can't reach the daemon now: an error for a request.
    fn refuse(&mut self, line: &[u8]) {
        if let Some(id) = serde_json::from_slice::<Value>(line)
            .ok()
            .as_ref()
            .and_then(request_id)
        {
            self.fail(id.clone());
        }
    }

    fn start_retry(&mut self, now: Instant) {
        self.retry = Some(Retry {
            since: now,
            delay: FIRST_DELAY,
            next: now + FIRST_DELAY,
        });
    }

    /// Runs until stdin ends; the exit code.
    pub fn serve(&mut self, rx: &mpsc::Receiver<Event>) -> i32 {
        loop {
            let ev = match self.retry.as_ref().map(|r| r.next) {
                Some(next) => match rx.recv_timeout(next.saturating_duration_since(Instant::now()))
                {
                    Ok(ev) => Some(ev),
                    Err(RecvTimeoutError::Timeout) => None,
                    Err(RecvTimeoutError::Disconnected) => return 0,
                },
                None => match rx.recv() {
                    Ok(ev) => Some(ev),
                    Err(_) => return 0,
                },
            };
            match ev {
                None => self.try_again(),
                Some(Event::In(line)) => {
                    if self.conn.is_some() {
                        if let Err(line) = self.forward(line) {
                            self.queue.push_back(line);
                        }
                        continue;
                    }
                    if self.retry.is_none() {
                        // It gave up before: this request tries again.
                        self.start_retry(Instant::now() - FIRST_DELAY);
                    }
                    if self.queue.len() < QUEUE {
                        self.queue.push_back(line);
                    } else {
                        self.refuse(&line);
                    }
                }
                Some(Event::InEnd) => {
                    self.stdin_done = true;
                    match &self.conn {
                        // The daemon ends the session when it sees the end; its last answers come first.
                        Some(s) if !self.pending.is_empty() => {
                            let _ = s.shutdown(Shutdown::Write);
                        }
                        _ => return 0,
                    }
                }
                Some(Event::Sock(n, line)) if n == self.n => {
                    let v = serde_json::from_slice::<Value>(&line).ok();
                    if let Some(v) = v.as_ref().filter(|v| method(v).is_none())
                        && let Some(id) = v.get("id")
                    {
                        if id.as_str().is_some_and(|i| i.starts_with(REINIT)) {
                            continue;
                        }
                        self.pending.retain(|p| p != id);
                    }
                    self.emit(&line);
                    if self.stdin_done && self.pending.is_empty() {
                        return 0;
                    }
                }
                Some(Event::SockEnd(n)) if n == self.n => {
                    self.conn = None;
                    if self.stdin_done {
                        return 0;
                    }
                    for id in std::mem::take(&mut self.pending) {
                        self.fail(id);
                    }
                    self.start_retry(Instant::now());
                }
                // An old connection's last words.
                Some(_) => {}
            }
        }
    }

    fn try_again(&mut self) {
        if self.connect().is_ok() {
            return;
        }
        let now = Instant::now();
        let Some(r) = self.retry.as_mut() else { return };
        if now.duration_since(r.since) >= GIVE_UP {
            self.retry = None;
            for line in std::mem::take(&mut self.queue) {
                self.refuse(&line);
            }
            return;
        }
        r.delay = (r.delay * 2).min(MAX_DELAY);
        r.next = now + r.delay;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::net::UnixListener;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct Out(Arc<Mutex<Vec<u8>>>);
    impl Write for Out {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn lines_of(r: &mut BufReader<UnixStream>, n: usize) -> Vec<String> {
        (0..n)
            .map(|_| {
                let mut s = String::new();
                r.read_line(&mut s).unwrap();
                s.trim_end().to_string()
            })
            .collect()
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("ekatva-rs-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.join("mcp.sock")
    }

    #[test]
    fn replays_the_session_after_a_restart() {
        let path = tmp("replay");
        let first = UnixListener::bind(&path).unwrap();
        let (tx, rx) = mpsc::channel();
        let out = Out::default();
        let mut pipe = Pipe::new(
            path.clone(),
            "{\"agent\":\"t\"}\n".into(),
            tx.clone(),
            Box::new(out.clone()),
        );
        pipe.connect().unwrap();
        let worker = thread::spawn(move || pipe.serve(&rx));
        let (s, _) = first.accept().unwrap();
        let mut r = BufReader::new(s.try_clone().unwrap());
        tx.send(Event::In(
            br#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{}}"#.to_vec(),
        ))
        .unwrap();
        tx.send(Event::In(
            br#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#.to_vec(),
        ))
        .unwrap();
        tx.send(Event::In(
            br#"{"jsonrpc":"2.0","id":7,"method":"tools/list"}"#.to_vec(),
        ))
        .unwrap();
        let got = lines_of(&mut r, 4);
        assert_eq!(got[0], r#"{"agent":"t"}"#);
        assert!(got[3].contains("tools/list"));
        s.try_clone()
            .unwrap()
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":0,\"result\":{}}\n")
            .unwrap();
        thread::sleep(Duration::from_millis(50));
        // The daemon restarts without answering 7.
        drop(r);
        s.shutdown(Shutdown::Both).unwrap();
        drop(first);
        std::fs::remove_file(&path).unwrap();
        thread::sleep(Duration::from_millis(50));
        tx.send(Event::In(
            br#"{"jsonrpc":"2.0","id":8,"method":"ping"}"#.to_vec(),
        ))
        .unwrap();
        let second = UnixListener::bind(&path).unwrap();
        let (s, _) = second.accept().unwrap();
        let mut r = BufReader::new(s.try_clone().unwrap());
        let got = lines_of(&mut r, 4);
        assert_eq!(got[0], r#"{"agent":"t"}"#);
        let reinit: Value = serde_json::from_str(&got[1]).unwrap();
        assert_eq!(reinit["id"], "pipe-reinit-1");
        assert_eq!(reinit["method"], "initialize");
        assert!(got[2].contains("notifications/initialized"));
        assert!(got[3].contains("\"id\":8"));
        let mut w = s.try_clone().unwrap();
        w.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":\"pipe-reinit-1\",\"result\":{}}\n{\"jsonrpc\":\"2.0\",\"id\":8,\"result\":{}}\n").unwrap();
        thread::sleep(Duration::from_millis(100));
        tx.send(Event::InEnd).unwrap();
        assert_eq!(worker.join().unwrap(), 0);
        let said = String::from_utf8(out.0.lock().unwrap().clone()).unwrap();
        let said: Vec<&str> = said.lines().collect();
        assert_eq!(said.len(), 3, "{said:?}");
        assert_eq!(said[0], r#"{"jsonrpc":"2.0","id":0,"result":{}}"#);
        let said = &said[1..];
        let err: Value = serde_json::from_str(said[0]).unwrap();
        assert_eq!(err["id"], 7);
        assert_eq!(err["error"]["code"], -32000);
        assert_eq!(err["error"]["message"], RESTARTED);
        assert_eq!(said[1], r#"{"jsonrpc":"2.0","id":8,"result":{}}"#);
    }

    #[test]
    fn answers_the_queue_when_the_daemon_stays_away() {
        let (tx, rx) = mpsc::channel();
        let out = Out::default();
        let mut pipe = Pipe::new(
            tmp("away"),
            String::new(),
            tx.clone(),
            Box::new(out.clone()),
        );
        // As if it had given up already: the next request tries once more.
        pipe.retry = Some(Retry {
            since: Instant::now() - GIVE_UP,
            delay: MAX_DELAY,
            next: Instant::now(),
        });
        let worker = thread::spawn(move || pipe.serve(&rx));
        tx.send(Event::In(
            br#"{"jsonrpc":"2.0","id":"a","method":"ping"}"#.to_vec(),
        ))
        .unwrap();
        thread::sleep(Duration::from_millis(100));
        tx.send(Event::InEnd).unwrap();
        assert_eq!(worker.join().unwrap(), 0);
        let said = String::from_utf8(out.0.lock().unwrap().clone()).unwrap();
        assert!(
            said.contains(r#""id":"a""#) && said.contains(RESTARTED),
            "{said}"
        );
    }

    #[test]
    fn path_is_beside_the_local_socket() {
        assert!(crate::paths::mcp_socket().ends_with("ekatva/mcp.sock"));
    }
}
