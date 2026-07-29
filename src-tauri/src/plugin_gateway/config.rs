use std::path::PathBuf;

pub const PORT_FILE: &str = ".gateway_port";

pub fn plugins_dir() -> PathBuf {
    if let Ok(home) = std::env::var("QOMICEX_HOME") {
        PathBuf::from(home).join("plugins")
    } else if let Ok(home) = std::env::var("HOME") {
        PathBuf::from(home).join(".local/share/Qomicex/plugins")
    } else {
        PathBuf::from(".").join("Qomicex").join("plugins")
    }
}
