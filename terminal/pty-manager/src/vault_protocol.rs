/// The vault wire is frozen. Do not bump this.
///
/// A vault outlives every binary that talks to it: after a failed update the host keeps the older
/// vault serving rather than close the last master descriptor for every session (ADR-0080). Every
/// vault ever shipped rejects a request whose version is above its own, and that code is already
/// running on machines and cannot be changed retroactively. So a bump does not negotiate anything;
/// it only makes new managers unable to speak to the vault holding their sessions.
///
/// Evolve the vault wire with protobuf's own rules instead: add fields, add `oneof` payload
/// variants, never renumber, and mark removals `reserved`. An older vault ignores a field it does
/// not know, and a newer manager tolerates one that is absent. A payload variant an older vault
/// cannot serve comes back as a normal request error, which the caller can handle.
pub const VAULT_PROTOCOL_VERSION: u32 = 1;

/// The oldest request version a vault will serve. Readers accept a range so that a manager built
/// from a different commit is never turned away for a number.
pub const VAULT_PROTOCOL_VERSION_MIN: u32 = 1;

pub mod generated {
    include!(concat!(env!("OUT_DIR"), "/pty.vault.v1.rs"));
}
