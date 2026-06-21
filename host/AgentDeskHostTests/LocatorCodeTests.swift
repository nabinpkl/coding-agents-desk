import Foundation
import Testing

struct LocatorCodeTests {
    @Test func roundTripsCGNATAddressesAndToken() throws {
        let addresses = ["100.64.0.10", "100.64.0.0", "100.127.255.255", "100.100.50.25"]
        let token = LocatorCode.makeFetchToken(from: Data([0x12, 0x34, 0x56, 0x78]))
        for address in addresses {
            let code = LocatorCode(tailnetIPv4: address, fetchToken: token)
            let decoded = try LocatorCode.decode(code.formatted())
            #expect(decoded.tailnetIPv4 == address)
            #expect(decoded.fetchToken == token)
        }
    }

    @Test func preservesFullThirtyBitTokenRange() throws {
        let token = LocatorCode.makeFetchToken(from: Data([0xFF, 0xFF, 0xFF, 0xFF]))
        // Top two bits dropped, low 30 bits kept.
        #expect(token == Data([0x3F, 0xFF, 0xFF, 0xFF]))
        let code = LocatorCode(tailnetIPv4: "100.96.12.34", fetchToken: token)
        let decoded = try LocatorCode.decode(code.formatted())
        #expect(decoded.fetchToken == token)
        #expect(decoded.tailnetIPv4 == "100.96.12.34")
    }

    @Test func formattedRejectsAddressesOutsideCGNAT() {
        for address in ["10.0.0.1", "192.168.1.1", "100.128.0.1", "99.64.0.1"] {
            let code = LocatorCode(tailnetIPv4: address, fetchToken: Data([0, 0, 0, 0]))
            #expect(throws: LocatorCodeError.ipOutsideCGNAT) {
                _ = try code.formatted()
            }
        }
    }

    @Test func decodeRejectsWrongLength() {
        #expect(throws: LocatorCodeError.malformedLength) {
            _ = try LocatorCode.decode("0000-A000-000")
        }
        #expect(throws: LocatorCodeError.malformedLength) {
            _ = try LocatorCode.decode("0000-A000-000UU")
        }
    }

    @Test func decodeRejectsChecksumMutation() {
        // One data symbol flipped, length intact: the check symbol no longer matches.
        #expect(throws: LocatorCodeError.checksumMismatch) {
            _ = try LocatorCode.decode("1000-A000-000U")
        }
    }

    @Test func decodeRejectsInvalidCharacter() {
        // 'U' is a check-only symbol and never valid in a data position.
        #expect(throws: LocatorCodeError.invalidCharacter) {
            _ = try LocatorCode.decode("U000-A000-000U")
        }
    }

    @Test func decodeNormalizesCaseAndAmbiguousCharacters() throws {
        let canonical = try LocatorCode(
            tailnetIPv4: "100.64.0.10",
            fetchToken: Data([0, 0, 0, 0])
        ).formatted()
        #expect(canonical == "0000-A000-000U")
        // Lowercase plus O->0, I/L->1 substitutions must decode identically.
        let mangled = canonical.lowercased().replacingOccurrences(of: "0", with: "O")
        let decoded = try LocatorCode.decode(mangled)
        #expect(decoded.tailnetIPv4 == "100.64.0.10")
        #expect(decoded.fetchToken == Data([0, 0, 0, 0]))
    }

    // Parity guard: the host and client copies of LocatorCode must produce the
    // exact same string for a fixed input, or the duplicated files have drifted.
    @Test func encodesFixedInputToStableString() throws {
        let code = LocatorCode(tailnetIPv4: "100.64.0.10", fetchToken: Data([0, 0, 0, 0]))
        #expect(try code.formatted() == "0000-A000-000U")
    }
}
