//! What the link keeps in its state folder (/var/lib/ekatva, owned by the
//! `ekatva` user, 0700): its settings, the laptop's identity key, and the
//! paired phones with their grants (devices.json, the same records the
//! session's daemon kept: migrating is a copy).

use std::fs;
use std::io;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::crypto::{KeyPair, b64u, from_b64u};

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    /// The laptop's name, as phones show it.
    pub name: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default = "default_host")]
    pub host: String,
    /// The uid whose session may attach (one user for now).
    pub owner: u32,
    /// The greeter's uid (greetd's `greeter` user), for logging in from a phone.
    #[serde(default)]
    pub greeter: Option<u32>,
    /// Send the LAN beacon.
    #[serde(default = "yes")]
    pub advertise: bool,
    /// The tunnel's public address, when there's one ("ekatva-tunnel.example.dev").
    #[serde(default)]
    pub hostname: Option<String>,
    /// The mailbox server (ntfy); None: no mailbox.
    #[serde(default)]
    pub ntfy: Option<String>,
}

fn default_port() -> u16 {
    47100
}
fn default_host() -> String {
    "0.0.0.0".into()
}
fn yes() -> bool {
    true
}

impl Config {
    /// The tunnel's address as phones keep it: `wss://host`, no path (the phone
    /// adds /link itself, as it did with the session's daemon).
    pub fn url(&self) -> Option<String> {
        self.hostname.as_ref().map(|h| format!("wss://{h}"))
    }
}

pub struct Store {
    pub dir: PathBuf,
}

fn private_write(path: &Path, data: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        io::Write::write_all(&mut f, data)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

impl Store {
    pub fn open(dir: PathBuf) -> io::Result<Self> {
        fs::create_dir_all(&dir)?;
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
        Ok(Store { dir })
    }

    pub fn config(&self) -> io::Result<Config> {
        let text = fs::read_to_string(self.dir.join("link.json"))?;
        serde_json::from_str(&text).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, format!("link.json: {e}")))
    }

    /// The identity: made on the first start, or migrated in from the session's keyring.
    pub fn identity(&self) -> io::Result<KeyPair> {
        let file = self.dir.join("identity.key");
        if let Ok(text) = fs::read_to_string(&file) {
            let secret: [u8; 32] = from_b64u(&text)
                .and_then(|b| b.try_into().ok())
                .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "identity.key is damaged"))?;
            return Ok(KeyPair::from_secret(secret));
        }
        let key = KeyPair::generate();
        private_write(&file, b64u(&key.secret).as_bytes())?;
        Ok(key)
    }

    pub fn devices(&self) -> Vec<Device> {
        fs::read_to_string(self.dir.join("devices.json"))
            .ok()
            .and_then(|t| serde_json::from_str(&t).ok())
            .unwrap_or_default()
    }

    pub fn save_devices(&self, list: &[Device]) -> io::Result<()> {
        private_write(&self.dir.join("devices.json"), serde_json::to_string_pretty(list)?.as_bytes())
    }
}

/// A paired phone, as the session's daemon keeps it (devices.ts DeviceRecord).
/// Unknown fields pass through untouched.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub key: String,
    pub name: String,
    #[serde(default)]
    pub grants: Vec<String>,
    #[serde(default)]
    pub paired_at: f64,
    #[serde(default)]
    pub last_seen: f64,
    #[serde(default)]
    pub info: Map<String, Value>,
    #[serde(flatten)]
    pub rest: Map<String, Value>,
}

impl Device {
    pub fn may(&self, cap: &str) -> bool {
        self.grants.iter().any(|g| g == cap)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn devices_round_trip_keeping_unknown_fields() {
        let dir = std::env::temp_dir().join(format!("ekatva-link-store-{}", std::process::id()));
        let s = Store::open(dir.clone()).unwrap();
        let text = r#"[{"key":"k","name":"P","grants":["status"],"pairedAt":1,"lastSeen":2,"info":{"a":"b"},"extra":7}]"#;
        fs::write(dir.join("devices.json"), text).unwrap();
        let d = s.devices();
        assert!(d[0].may("status") && !d[0].may("root"));
        s.save_devices(&d).unwrap();
        let back: Value = serde_json::from_str(&fs::read_to_string(dir.join("devices.json")).unwrap()).unwrap();
        assert_eq!(back[0]["extra"], 7);
        let id1 = s.identity().unwrap();
        assert_eq!(s.identity().unwrap().public, id1.public);
        fs::remove_dir_all(dir).unwrap();
    }
}
