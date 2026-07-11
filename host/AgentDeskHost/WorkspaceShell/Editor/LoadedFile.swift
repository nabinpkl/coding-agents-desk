import Foundation

struct LoadedFile {
    let url: URL
    var text = ""
    var kind: FilePreviewKind? = nil
    var unsupportedReason: String? = nil

    func unsupported(_ reason: String) -> LoadedFile {
        LoadedFile(url: url, unsupportedReason: reason)
    }
}
