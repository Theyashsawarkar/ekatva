//! Where things are: the same rules as apps/daemon/src/paths.ts.

use std::env;
use std::path::PathBuf;

fn var(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

fn home() -> PathBuf {
    var("HOME").unwrap_or_else(|| PathBuf::from("/"))
}

/// `$XDG_RUNTIME_DIR`, else ekatva's state directory.
pub fn runtime() -> PathBuf {
    var("XDG_RUNTIME_DIR").unwrap_or_else(|| {
        var("XDG_STATE_HOME")
            .unwrap_or_else(|| home().join(".local/state"))
            .join("ekatva")
    })
}

/// The local socket (tRPC over WebSocket), as the CLI uses it.
pub fn socket() -> PathBuf {
    runtime().join("ekatva.sock")
}

/// The TypeScript CLI: `$EKATVA_TS_CLI` (the launcher sets it), else
/// apps/daemon/bin/ekatva.js in the checkout this binary was built in.
pub fn ts_cli() -> PathBuf {
    if let Some(p) = var("EKATVA_TS_CLI") {
        return p;
    }
    if let Ok(exe) = env::current_exe().and_then(std::fs::canonicalize) {
        for dir in exe.ancestors() {
            let cli = dir.join("apps/daemon/bin/ekatva.js");
            if cli.is_file() {
                return cli;
            }
        }
    }
    PathBuf::from("ekatva.js")
}
