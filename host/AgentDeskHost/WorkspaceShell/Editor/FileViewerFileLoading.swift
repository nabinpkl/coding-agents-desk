import Foundation
import os

extension FileViewer {
    func readFile(_ url: URL) -> LoadedFile {
        let base = LoadedFile(url: url)
        let kind = FilePreviewKind.classify(url)
        if kind == .docx {
            do {
                let values = try url.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
                guard values.isRegularFile == true else {
                    return base.unsupported("Not a regular file")
                }
                guard let fileSize = values.fileSize else {
                    return base.unsupported("Could not determine document size")
                }
                guard fileSize <= Config.workspaceDocumentMaxBytes else {
                    return base.unsupported("This document exceeds the supported size")
                }
            } catch {
                logger.error("read failed for \(url.path, privacy: .public): \(String(describing: error), privacy: .public)")
                return base.unsupported("Could not read \(url.lastPathComponent)")
            }
            onDidReadFile?(url)
            return LoadedFile(url: url, kind: .docx, documentURL: url)
        }
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            logger.error("read failed for \(url.path, privacy: .public): \(String(describing: error), privacy: .public)")
            return base.unsupported("Could not read \(url.lastPathComponent)")
        }
        onDidReadFile?(url)
        guard !TextProbe.isProbablyBinary(data) else {
            return base.unsupported("No preview for binary files")
        }
        guard let text = String(data: data, encoding: .utf8) else {
            return base.unsupported("Not a UTF-8 text file")
        }
        return LoadedFile(url: url, text: text, kind: kind)
    }

    func apply(_ loaded: LoadedFile, to tab: FileTab) {
        tab.text = loaded.text
        tab.kind = loaded.kind
        tab.documentURL = loaded.documentURL
        tab.unsupportedReason = loaded.unsupportedReason
        tab.markLoaded()
    }
}
