//! The LAN beacon (as the session's beacon.ts did): every 3 s, one sealed
//! datagram per paired phone to each local network's broadcast address; once
//! every phone is connected directly, only every 20th. Also the laptop's LAN
//! addresses, for the mailbox's "here".

use std::ffi::CStr;
use std::net::{Ipv4Addr, UdpSocket};
use std::sync::Arc;
use std::time::Duration;

use crate::crypto::{beacon_key, from_b64u, seal_beacon};
use crate::hub::{Hub, log, now_ms};

const BEACON_PORT: u16 = 47101;
const VIRTUAL: &[&str] = &[
    "docker", "br-", "veth", "virbr", "vmnet", "vboxnet", "lxc", "lxd", "podman", "cni", "flannel", "tun", "tap", "wg",
    "tailscale", "zt",
];

/// (address, broadcast) for each real IPv4 network the laptop is on.
pub fn networks() -> Vec<(Ipv4Addr, Ipv4Addr)> {
    let mut out = Vec::new();
    let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs fills a list we walk read-only and free once.
    unsafe {
        if libc::getifaddrs(&mut list) != 0 {
            return out;
        }
        let mut p = list;
        while !p.is_null() {
            let a = &*p;
            p = a.ifa_next;
            if a.ifa_addr.is_null() || a.ifa_netmask.is_null() || i32::from((*a.ifa_addr).sa_family) != libc::AF_INET {
                continue;
            }
            let name = CStr::from_ptr(a.ifa_name).to_string_lossy();
            if name == "lo" || VIRTUAL.iter().any(|v| name.starts_with(v)) {
                continue;
            }
            let addr = Ipv4Addr::from(u32::from_be((*(a.ifa_addr as *const libc::sockaddr_in)).sin_addr.s_addr));
            let mask = Ipv4Addr::from(u32::from_be((*(a.ifa_netmask as *const libc::sockaddr_in)).sin_addr.s_addr));
            if addr.is_loopback() || addr.is_link_local() {
                continue;
            }
            out.push((addr, Ipv4Addr::from(u32::from(addr) | !u32::from(mask))));
        }
        libc::freeifaddrs(list);
    }
    out.sort();
    out.dedup();
    out
}

/// host:port on each local network, as phones dial them.
pub fn lan(port: u16) -> Vec<String> {
    networks().into_iter().map(|(a, _)| format!("{a}:{port}")).collect()
}

pub fn run(hub: Arc<Hub>) {
    let s = match UdpSocket::bind("0.0.0.0:0").and_then(|s| s.set_broadcast(true).map(|_| s)) {
        Ok(s) => s,
        Err(e) => {
            log(&format!("beacon: {e}"));
            return;
        }
    };
    let mut ticks: u64 = 0;
    loop {
        let devices = hub.devices();
        let online = hub.online();
        let quiet = !devices.is_empty() && devices.iter().all(|d| online.iter().any(|(k, v)| *k == d.key && *v == "lan"));
        let send = !quiet || ticks.is_multiple_of(20);
        ticks = if quiet { ticks + 1 } else { 0 };
        if send {
            let targets: Vec<Ipv4Addr> = networks().into_iter().map(|(_, b)| b).collect();
            for d in &devices {
                let Some(other) = from_b64u(&d.key).and_then(|k| <[u8; 32]>::try_from(k).ok()) else { continue };
                let datagram = seal_beacon(&beacon_key(&hub.me, &other), now_ms(), hub.cfg.port);
                for t in &targets {
                    let _ = s.send_to(&datagram, (*t, BEACON_PORT));
                }
            }
        }
        std::thread::sleep(Duration::from_secs(3));
    }
}
