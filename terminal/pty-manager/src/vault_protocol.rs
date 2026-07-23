pub const VAULT_PROTOCOL_VERSION: u32 = 1;

pub mod generated {
    include!(concat!(env!("OUT_DIR"), "/pty.vault.v1.rs"));
}
