//! Finding the laptop from anywhere (as the session's rendezvous.ts did): each
//! pair's private mailbox on ntfy. The link listens to all of them on one
//! stream; when something is posted it reads the new messages and answers a
//! phone's "where are you?" with "here": the tunnel's address and the LAN's.
//! It also says "here" unasked when it starts, so a phone learns the address
//! after a reboot without asking.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

use crate::beacon::lan;
use crate::crypto::{Mailbox, from_b64u};
use crate::hub::{Hub, log, now_ms};

const MAX_AGE_MS: f64 = 10.0 * 60.0 * 1000.0;

fn agent() -> ureq::Agent {
    ureq::AgentBuilder::new().timeout_connect(Duration::from_secs(15)).timeout_read(Duration::from_secs(70)).build()
}

fn boxes(hub: &Hub) -> Vec<(String, Mailbox)> {
    hub.devices()
        .into_iter()
        .filter_map(|d| {
            let k: [u8; 32] = from_b64u(&d.key)?.try_into().ok()?;
            Some((d.name, Mailbox::new(&hub.me, &k)))
        })
        .collect()
}

fn here(hub: &Hub, n: &str) -> Value {
    json!({"t": "here", "at": now_ms(), "url": hub.cfg.url(), "lan": lan(hub.cfg.port), "n": n})
}

pub fn run(hub: Arc<Hub>, server: String) {
    let http = agent();
    // Say where it is once, unasked (n = "": an announcement).
    for (_, mb) in boxes(&hub) {
        let _ = http.post(&format!("{server}/{}", mb.topic)).send_string(&mb.seal(&here(&hub, "")));
    }
    let mut last: HashMap<String, String> = HashMap::new();
    let mut answered: HashSet<String> = HashSet::new();
    let mut failing = false;
    let mut retry = Duration::from_secs(1);
    loop {
        let list = boxes(&hub);
        if list.is_empty() {
            std::thread::sleep(Duration::from_secs(60));
            continue;
        }
        let topics: Vec<&str> = list.iter().map(|(_, m)| m.topic.as_str()).collect();
        check(&hub, &http, &server, &list, &mut last, &mut answered, &mut failing);
        // One long-lived stream; ntfy sends a keepalive every 45 s, so a read
        // that waits 70 s means the stream is gone: open it again.
        match http.get(&format!("{server}/{}/json", topics.join(","))).call() {
            Ok(r) => {
                retry = Duration::from_secs(1);
                for line in BufReader::new(r.into_reader()).lines() {
                    let Ok(line) = line else { break };
                    if line.contains("\"event\":\"message\"") {
                        check(&hub, &http, &server, &list, &mut last, &mut answered, &mut failing);
                    }
                    // A phone paired or unpaired: listen to the new set.
                    if boxes(&hub).len() != list.len() {
                        break;
                    }
                }
            }
            Err(e) => {
                if !failing {
                    log(&format!("can't listen at the rendezvous: {e}"));
                }
                failing = true;
                std::thread::sleep(retry);
                retry = (retry * 2).min(Duration::from_secs(60));
            }
        }
    }
}

fn check(
    hub: &Hub,
    http: &ureq::Agent,
    server: &str,
    list: &[(String, Mailbox)],
    last: &mut HashMap<String, String>,
    answered: &mut HashSet<String>,
    failing: &mut bool,
) {
    for (name, mb) in list {
        let since = last.get(&mb.topic).cloned().unwrap_or_else(|| "2m".into());
        let body = match http.get(&format!("{server}/{}/json", mb.topic)).query("poll", "1").query("since", &since).call() {
            Ok(r) => r.into_string().unwrap_or_default(),
            Err(e) => {
                if !*failing {
                    log(&format!("can't reach the rendezvous: {e}"));
                }
                *failing = true;
                continue;
            }
        };
        if *failing {
            log("the rendezvous answers again");
        }
        *failing = false;
        for line in body.lines() {
            let Ok(m) = serde_json::from_str::<Value>(line) else { continue };
            if m.get("event").and_then(Value::as_str) != Some("message") {
                continue;
            }
            if let Some(id) = m.get("id").and_then(Value::as_str) {
                last.insert(mb.topic.clone(), id.to_string());
            }
            let Some(msg) = m.get("message").and_then(Value::as_str).and_then(|t| mb.open(t)) else { continue };
            let fresh = msg.get("at").and_then(Value::as_f64).is_some_and(|at| (now_ms() - at).abs() <= MAX_AGE_MS);
            let n = msg.get("n").and_then(Value::as_str).unwrap_or("").to_string();
            if msg.get("t").and_then(Value::as_str) != Some("where") || !fresh || !answered.insert(n.clone()) {
                continue;
            }
            log(&format!("{name} is looking for the laptop from elsewhere"));
            let _ = http.post(&format!("{server}/{}", mb.topic)).send_string(&mb.seal(&here(hub, &n)));
        }
    }
}
