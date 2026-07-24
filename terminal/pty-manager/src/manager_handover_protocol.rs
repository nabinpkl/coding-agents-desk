pub const MANAGER_HANDOVER_PROTOCOL_VERSION: u32 = 1;

pub mod generated {
    include!(concat!(env!("OUT_DIR"), "/pty.manager.handover.v1.rs"));
}
