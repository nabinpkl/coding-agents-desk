import Foundation

@MainActor
public protocol FileViewing: AnyObject {
    var assignedDesktopWindowID: UInt32? { get }
    var onFrameChanged: ((CGRect) -> Void)? { get set }
    var onActivateTab: ((FileTabIdentity) -> Void)? { get set }
    var onCloseTab: ((FileTabIdentity) -> Void)? { get set }
    var onSave: ((URL, String) throws -> Void)? { get set }
    var onDidReadFile: ((URL) -> Void)? { get set }
    var onOpenFile: ((URL) -> Void)? { get set }
    var onListDirectory: ((URL) -> [DirectoryListingEntry])? { get set }

    func render(tabs: [FileTabIdentity], active: FileTabIdentity?, in workspace: Workspace?)
    func clear()
    func setHidden(_ hidden: Bool)
    func prepareForAssignedDesktop(in frame: CGRect)
    func revealAfterAssignedDesktop(in frame: CGRect, focus: Bool)
    func hideAfterAssignedDesktopFailure()
    func reloadFromDisk(_ url: URL)
    func markDeletedOnDisk(_ url: URL)
    func setTextZoom(_ zoom: WorkspaceTextZoom)
    func focusForAccessibility() -> Bool
}
