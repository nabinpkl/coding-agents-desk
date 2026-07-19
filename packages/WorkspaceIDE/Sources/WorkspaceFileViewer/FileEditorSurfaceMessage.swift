import Foundation

enum FileEditorSurfaceMessage: Equatable {
    enum ParseError: Error, Equatable {
        case notDictionary
        case missingType
        case missingField(String, type: String)
        case unknownType(String)
    }

    case ready
    case dirty(id: String, text: String)
    case edit(id: String)
    case runNotebookCell(id: String, cellIndex: Int, source: String)

    static func parse(_ body: Any) throws -> FileEditorSurfaceMessage {
        guard let message = body as? [String: Any] else { throw ParseError.notDictionary }
        guard let type = message["type"] as? String else { throw ParseError.missingType }

        switch type {
        case "ready":
            return .ready
        case "dirty":
            return .dirty(
                id: try string("id", in: message),
                text: try string("text", in: message)
            )
        case "edit":
            return .edit(id: try string("id", in: message))
        case "runNotebookCell":
            return .runNotebookCell(
                id: try string("id", in: message),
                cellIndex: try int("cellIndex", in: message),
                source: try string("source", in: message)
            )
        default:
            throw ParseError.unknownType(type)
        }
    }

    private static func string(_ key: String, in message: [String: Any]) throws -> String {
        guard let value = message[key] as? String else {
            throw ParseError.missingField(key, type: "String")
        }
        return value
    }

    private static func int(_ key: String, in message: [String: Any]) throws -> Int {
        guard let value = message[key] as? Int else {
            throw ParseError.missingField(key, type: "Int")
        }
        return value
    }
}
