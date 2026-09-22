use std::fs;
use std::path::PathBuf;

fn main() {
    println!("cargo::rerun-if-env-changed=TARGET");

    let target = std::env::var("TARGET").unwrap_or_default();
    if !target.contains("windows") {
        return;
    }
    let arch = if target.starts_with("x86_64") {
        "x86_64"
    } else if target.starts_with("aarch64") {
        "arm64"
    } else {
        return;
    };

    let manifest = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let src = manifest.join(format!(
        "../../qomicex-connector-rust/easytier/third_party/{arch}"
    ));
    println!("cargo::rerun-if-changed={}", src.display());

    // ponytail: OUT_DIR = <target_dir>/[<triple>/]<profile>/build/<pkg>-<hash>/out，exe 目录在其上 3 级
    let exe_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap())
        .ancestors()
        .nth(3)
        .expect("OUT_DIR layout changed")
        .to_path_buf();

    for dll in ["Packet.dll", "wintun.dll"] {
        fs::copy(src.join(dll), exe_dir.join(dll))
            .unwrap_or_else(|e| panic!("copy {dll} to {} failed: {e}", exe_dir.display()));
    }
}
