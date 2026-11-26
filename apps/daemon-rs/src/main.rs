//! `ekatva-rs`: the part of the `ekatva` CLI that runs as long as waybar
//! does, without a Node runtime: `call --waybar`, the bar's call capsule.
//! Anything else runs the TypeScript CLI (apps/daemon), unchanged. (Agents'
//! MCP sessions go through `pranali ekatva` now.)

mod paths;
mod waybar;

use std::ffi::OsString;
use std::os::unix::process::CommandExt;
use std::process::Command;

fn main() {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    match args.first().and_then(|a| a.to_str()) {
        Some("call") if args[1..].iter().any(|a| a == "--waybar") => waybar::run(),
        _ => exec_ts(&args),
    }
}

/// Replaces this process with the TypeScript CLI, given the same arguments.
pub fn exec_ts(args: &[OsString]) -> ! {
    let cli = paths::ts_cli();
    let err = Command::new(&cli).args(args).exec();
    eprintln!("ekatva: can't run {}: {err}", cli.display());
    std::process::exit(127);
}
