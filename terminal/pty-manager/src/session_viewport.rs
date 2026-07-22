use std::collections::HashMap;

use crate::error::{Result, TerminalError};
use crate::protocol::TerminalViewerState;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ViewerViewport {
    pub(crate) sequence: u64,
    pub(crate) active: bool,
    pub(crate) columns: u16,
    pub(crate) rows: u16,
    activation_ordinal: u64,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ViewportDecision {
    pub(crate) owner_changed: bool,
    pub(crate) requested_dimensions: Option<(u16, u16)>,
}

#[derive(Debug, Default)]
pub(crate) struct SessionViewport {
    viewers: HashMap<u64, ViewerViewport>,
    owner_client_id: Option<u64>,
    ownership_epoch: u64,
    next_activation_ordinal: u64,
}

impl SessionViewport {
    pub(crate) fn register(&mut self, client_id: u64, columns: u16, rows: u16) {
        self.viewers.insert(
            client_id,
            ViewerViewport {
                columns,
                rows,
                ..ViewerViewport::default()
            },
        );
    }

    pub(crate) fn update(
        &mut self,
        client_id: u64,
        state: TerminalViewerState,
        columns: u16,
        rows: u16,
    ) -> Result<ViewportDecision> {
        if state.sequence == 0 {
            return Err(TerminalError::Protocol(
                "terminal viewer sequence must be positive".to_owned(),
            ));
        }
        if state.claim && !state.active {
            return Err(TerminalError::Protocol(
                "inactive terminal viewer cannot claim ownership".to_owned(),
            ));
        }
        let viewer = self
            .viewers
            .get_mut(&client_id)
            .ok_or(TerminalError::ClientNotFound(client_id))?;
        if state.sequence <= viewer.sequence {
            return Err(TerminalError::Protocol(
                "stale terminal viewer sequence".to_owned(),
            ));
        }
        viewer.sequence = state.sequence;
        viewer.active = state.active;
        viewer.columns = columns;
        viewer.rows = rows;

        let owner_changed = if state.claim {
            self.activate_and_select(client_id)?
        } else if !state.active && self.owner_client_id == Some(client_id) {
            self.select_fallback_owner()?
        } else {
            false
        };
        Ok(ViewportDecision {
            owner_changed,
            requested_dimensions: if owner_changed {
                self.owner_dimensions()
            } else {
                self.owner_dimensions_if(client_id)
            },
        })
    }

    pub(crate) fn claim_for_input(&mut self, client_id: u64) -> Result<ViewportDecision> {
        let viewer = self
            .viewers
            .get_mut(&client_id)
            .ok_or(TerminalError::ClientNotFound(client_id))?;
        viewer.active = true;
        let owner_changed = self.activate_and_select(client_id)?;
        Ok(ViewportDecision {
            owner_changed,
            requested_dimensions: self.owner_dimensions_if(client_id),
        })
    }

    pub(crate) fn remove(&mut self, client_id: u64) -> Result<ViewportDecision> {
        self.viewers.remove(&client_id);
        let owner_changed = if self.owner_client_id == Some(client_id) {
            self.select_fallback_owner()?
        } else {
            false
        };
        Ok(ViewportDecision {
            owner_changed,
            requested_dimensions: self.owner_dimensions(),
        })
    }

    pub(crate) fn owner_client_id(&self) -> u64 {
        self.owner_client_id.unwrap_or(0)
    }

    pub(crate) fn ownership_epoch(&self) -> u64 {
        self.ownership_epoch
    }

    pub(crate) fn viewer(&self, client_id: u64) -> Option<ViewerViewport> {
        self.viewers.get(&client_id).copied()
    }

    pub(crate) fn is_owner(&self, client_id: u64) -> bool {
        self.owner_client_id == Some(client_id)
    }

    fn activate_and_select(&mut self, client_id: u64) -> Result<bool> {
        self.next_activation_ordinal = self
            .next_activation_ordinal
            .checked_add(1)
            .ok_or_else(|| TerminalError::Protocol("terminal activation overflow".to_owned()))?;
        self.viewers
            .get_mut(&client_id)
            .ok_or(TerminalError::ClientNotFound(client_id))?
            .activation_ordinal = self.next_activation_ordinal;
        self.select_owner(Some(client_id))
    }

    fn select_fallback_owner(&mut self) -> Result<bool> {
        let fallback = self
            .viewers
            .iter()
            .filter(|(_, viewer)| viewer.active && viewer.activation_ordinal > 0)
            .max_by_key(|(_, viewer)| viewer.activation_ordinal)
            .map(|(client_id, _)| *client_id);
        self.select_owner(fallback)
    }

    fn select_owner(&mut self, owner: Option<u64>) -> Result<bool> {
        if self.owner_client_id == owner {
            return Ok(false);
        }
        self.ownership_epoch = self.ownership_epoch.checked_add(1).ok_or_else(|| {
            TerminalError::Protocol("terminal ownership epoch overflow".to_owned())
        })?;
        self.owner_client_id = owner;
        Ok(true)
    }

    fn owner_dimensions_if(&self, client_id: u64) -> Option<(u16, u16)> {
        (self.owner_client_id == Some(client_id))
            .then(|| self.owner_dimensions())
            .flatten()
    }

    fn owner_dimensions(&self) -> Option<(u16, u16)> {
        self.owner_client_id
            .and_then(|client_id| self.viewers.get(&client_id))
            .map(|viewer| (viewer.columns, viewer.rows))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state(
        sequence: u64,
        active: bool,
        claim: bool,
        columns: u32,
        rows: u32,
    ) -> TerminalViewerState {
        TerminalViewerState {
            sequence,
            active,
            claim,
            columns,
            rows,
        }
    }

    #[test]
    fn passive_viewer_does_not_take_ownership() {
        let mut viewport = SessionViewport::default();
        viewport.register(1, 80, 24);
        let decision = viewport
            .update(1, state(1, true, false, 100, 30), 100, 30)
            .unwrap();
        assert_eq!(decision, ViewportDecision::default());
        assert_eq!(viewport.owner_client_id(), 0);
    }

    #[test]
    fn latest_claim_wins_and_release_falls_back() {
        let mut viewport = SessionViewport::default();
        viewport.register(1, 80, 24);
        viewport.register(2, 80, 24);
        viewport
            .update(1, state(1, true, true, 100, 30), 100, 30)
            .unwrap();
        viewport
            .update(2, state(1, true, true, 60, 20), 60, 20)
            .unwrap();
        assert_eq!(viewport.owner_client_id(), 2);
        let decision = viewport
            .update(2, state(2, false, false, 60, 20), 60, 20)
            .unwrap();
        assert!(decision.owner_changed);
        assert_eq!(decision.requested_dimensions, Some((100, 30)));
        assert_eq!(viewport.owner_client_id(), 1);
    }

    #[test]
    fn stale_and_inactive_claims_fail() {
        let mut viewport = SessionViewport::default();
        viewport.register(1, 80, 24);
        viewport
            .update(1, state(1, true, false, 80, 24), 80, 24)
            .unwrap();
        assert!(viewport
            .update(1, state(1, true, true, 80, 24), 80, 24)
            .is_err());
        assert!(viewport
            .update(1, state(2, false, true, 80, 24), 80, 24)
            .is_err());
    }

    #[test]
    fn input_claim_activates_inactive_viewer_with_its_cached_dimensions() {
        let mut viewport = SessionViewport::default();
        viewport.register(1, 80, 24);
        viewport
            .update(1, state(1, false, false, 120, 40), 120, 40)
            .unwrap();

        let decision = viewport.claim_for_input(1).unwrap();

        assert!(decision.owner_changed);
        assert_eq!(decision.requested_dimensions, Some((120, 40)));
        assert_eq!(viewport.owner_client_id(), 1);
        assert!(viewport.viewer(1).unwrap().active);
    }

    #[test]
    fn releasing_final_owner_freezes_source_dimensions() {
        let mut viewport = SessionViewport::default();
        viewport.register(1, 80, 24);
        viewport
            .update(1, state(1, true, true, 120, 40), 120, 40)
            .unwrap();

        let decision = viewport
            .update(1, state(2, false, false, 120, 40), 120, 40)
            .unwrap();

        assert!(decision.owner_changed);
        assert_eq!(decision.requested_dimensions, None);
        assert_eq!(viewport.owner_client_id(), 0);
    }
}
