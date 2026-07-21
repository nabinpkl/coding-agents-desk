import AgentDeskWire
import BrowserProjection
import Foundation
import Testing

@testable import AgentDeskClient

struct DomMirrorClientTests {
    private func data(_ json: String) -> Data { Data(json.utf8) }

    @Test func classifiesProjectionFramesAndDiagnosticStatus() {
        #expect(DomLanePayloadClassifier.classify(data(#"{"t":"dom-batch","tb":1,"g":2,"co":true,"ev":[]}"#)) == .batch)
        #expect(DomLanePayloadClassifier.classify(data(#"{"t":"browser-state","generation":2,"extension":{"version":"0.9.0"},"viewport":{"active":false,"revision":1},"windows":[]}"#)) == .projectionMetadata)
        #expect(DomLanePayloadClassifier.classify(data(#"{"t":"projection-host","connected":true,"sha":"abc1234"}"#)) == .projectionMetadata)
        #expect(DomLanePayloadClassifier.classify(data(#"{"t":"browser-viewer-status","owner":true,"active":true,"profile":"mobile","sizing":"viewer","width":390,"height":844}"#)) == .projectionMetadata)
        #expect(DomLanePayloadClassifier.classify(data(#"{"t":"dom-status","ext":true,"tab":1}"#)) == .status(DomStatus(ext: true, tab: 1)))
    }

    @Test func rejectsUnknownAndMalformedFrames() {
        #expect(DomLanePayloadClassifier.classify(data(#"{"t":"unknown"}"#)) == .invalid)
        #expect(DomLanePayloadClassifier.classify(data(#"{"t":"browser-state","generation":-1,"extension":{"version":"0.9.0"},"viewport":{"active":false,"revision":1},"windows":[]}"#)) == .invalid)
        #expect(DomLanePayloadClassifier.classify(data(#"{"t":"browser-state","generation":2,"extension":{"version":"0.9.0"},"windows":[]}"#)) == .invalid)
        #expect(DomLanePayloadClassifier.classify(data(#"{"t":"projection-host","connected":"yes","sha":"abc1234"}"#)) == .invalid)
        #expect(DomLanePayloadClassifier.classify(data(#"{"t":"browser-viewer-status","owner":true}"#)) == .invalid)
        #expect(DomLanePayloadClassifier.classify(data(#"{"t":"browser-viewer-status","owner":false,"active":true,"profile":"desktop","sizing":"custom","width":4097,"height":800}"#)) == .invalid)
        #expect(DomLanePayloadClassifier.classify(data("not json")) == .invalid)
    }
}
