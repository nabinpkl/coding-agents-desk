import Foundation

/// Namespace for the shared embedded workspace IDE introduced by ADR-0062.
///
/// The concrete coordinator is added behind this product so existing single-file surfaces can keep
/// importing `WorkspaceFileViewer` during the parallel rollout.
public enum WorkspaceIDE {
    public static let autosaveDelay: Duration = .milliseconds(700)
}
