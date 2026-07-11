import Foundation

/// One clickable segment in the file viewer breadcrumb. `title` is the visible label;
/// `directory` is the folder whose children should be listed when the segment is clicked.
public struct FileBreadcrumbSegment: Equatable {
    public let title: String
    public let directory: URL

    public init(title: String, directory: URL) {
        self.title = title
        self.directory = directory.standardizedFileURL
    }

    public static func segments(forRootOf workspace: Workspace) -> [FileBreadcrumbSegment] {
        [FileBreadcrumbSegment(title: workspace.name, directory: workspace.root)]
    }

    public static func segments(for fileURL: URL, in workspace: Workspace?) -> [FileBreadcrumbSegment] {
        let file = fileURL.standardizedFileURL
        guard let workspace,
              let relativeParts = relativePathParts(file: file, root: workspace.root.standardizedFileURL)
        else {
            return [FileBreadcrumbSegment(title: file.path, directory: file.deletingLastPathComponent())]
        }

        var segments = segments(forRootOf: workspace)
        guard let fileName = relativeParts.last else { return segments }

        var current = workspace.root.standardizedFileURL
        for part in relativeParts.dropLast() {
            current = current.appendingPathComponent(part, isDirectory: true)
            segments.append(FileBreadcrumbSegment(title: part, directory: current))
        }
        segments.append(FileBreadcrumbSegment(title: fileName, directory: current))
        return segments
    }

    public static func displayPath(for fileURL: URL, in workspace: Workspace?) -> String {
        let file = fileURL.standardizedFileURL
        guard let workspace,
              let relativeParts = relativePathParts(file: file, root: workspace.root.standardizedFileURL)
        else {
            return file.path
        }
        return relativeParts.joined(separator: "/")
    }

    private static func relativePathParts(file: URL, root: URL) -> [String]? {
        let rootParts = root.pathComponents
        let fileParts = file.pathComponents
        guard fileParts.count > rootParts.count, fileParts.starts(with: rootParts) else { return nil }
        return Array(fileParts.dropFirst(rootParts.count))
    }
}
