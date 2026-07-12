import Foundation

public protocol PtyTransport: AnyObject {
    func sendFrame(_ data: Data) async throws
    func receiveFrame() async throws -> Data
    func close()
}
