pub fn has_permission(permissions: &[String], required: &str) -> bool {
    permissions.iter().any(|p| p == required)
}

pub mod perm {
    pub const NETWORK_FETCH: &str = "network:fetch";
    pub const INSTANCE_READ: &str = "instance:read";
    pub const WASM_EXECUTE: &str = "wasm:execute";
}
