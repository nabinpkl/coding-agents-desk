import Foundation

// ADR-0018 code pairing. A short human-typeable code that carries the host's
// Tailscale IPv4 plus a one-time fetch token, so a remote iPhone can reach the
// host over the tailnet and pull the signed pairing payload without scanning a
// QR. Duplicated verbatim in host and client; both copies must stay
// byte-identical (asserted by a parity test in each suite).
//
// Layout: Tailscale CGNAT is 100.64.0.0/10, so the top 10 address bits are
// fixed and only 22 vary. Pack those 22 bits plus a 30-bit token into a
// 52-bit value, encode as 11 Crockford base32 symbols, append one Crockford
// check symbol, and group as XXXX-XXXX-XXXX (12 chars). Crockford's alphabet
// omits I, L, O, U so the code cannot be mistyped into a different value;
// decoding normalizes case and maps I/L->1, O->0.

enum LocatorCodeError: Error, Equatable {
    case ipOutsideCGNAT
    case malformedLength
    case invalidCharacter
    case checksumMismatch
    case tokenOutOfRange
}

struct LocatorCode: Equatable {
    let tailnetIPv4: String
    let fetchToken: Data

    // 100.64.0.0/10: top 10 bits fixed, 22 host bits free.
    private static let cgnatPrefix: UInt32 = 0x6440_0000   // 100.64.0.0
    private static let cgnatMask: UInt32 = 0xFFC0_0000      // /10
    private static let ipHostMask: UInt32 = 0x003F_FFFF     // low 22 bits
    private static let tokenBitCount = 30
    private static let tokenMask: UInt64 = (1 << 30) - 1
    private static let dataSymbolCount = 11                 // ceil(52 / 5)

    // Crockford base32: indices 0-31 are the alphabet, 32-36 are check-only.
    private static let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
    private static let checkAlphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ*~$=U")

    init(tailnetIPv4: String, fetchToken: Data) {
        self.tailnetIPv4 = tailnetIPv4
        self.fetchToken = fetchToken
    }

    func formatted() throws -> String {
        let address = try Self.ipv4ToUInt32(tailnetIPv4)
        guard address & Self.cgnatMask == Self.cgnatPrefix else {
            throw LocatorCodeError.ipOutsideCGNAT
        }
        let token = Self.tokenToUInt64(fetchToken)
        guard token <= Self.tokenMask else {
            throw LocatorCodeError.tokenOutOfRange
        }
        let ipHost = UInt64(address & Self.ipHostMask)
        let value = (ipHost << UInt64(Self.tokenBitCount)) | token

        var symbols = ""
        for index in 0..<Self.dataSymbolCount {
            let shift = 5 * (Self.dataSymbolCount - 1 - index)
            let symbol = Int((value >> UInt64(shift)) & 0x1F)
            symbols.append(Self.alphabet[symbol])
        }
        symbols.append(Self.checkAlphabet[Int(value % 37)])
        return Self.group(symbols)
    }

    static func decode(_ raw: String) throws -> LocatorCode {
        let normalized = normalize(raw)
        guard normalized.count == dataSymbolCount + 1 else {
            throw LocatorCodeError.malformedLength
        }
        let chars = Array(normalized)
        var value: UInt64 = 0
        for index in 0..<dataSymbolCount {
            guard let symbol = alphabet.firstIndex(of: chars[index]) else {
                throw LocatorCodeError.invalidCharacter
            }
            value = (value << 5) | UInt64(symbol)
        }
        // 11 symbols carry 55 bits; the top 3 must be zero for a 52-bit value.
        guard value >> 52 == 0 else {
            throw LocatorCodeError.malformedLength
        }
        guard let check = checkAlphabet.firstIndex(of: chars[dataSymbolCount]) else {
            throw LocatorCodeError.invalidCharacter
        }
        guard UInt64(check) == value % 37 else {
            throw LocatorCodeError.checksumMismatch
        }
        let token = value & tokenMask
        let ipHost = UInt32((value >> UInt64(tokenBitCount)) & UInt64(ipHostMask))
        let address = cgnatPrefix | ipHost
        return LocatorCode(tailnetIPv4: uint32ToIPv4(address), fetchToken: tokenToData(token))
    }

    // MARK: - Helpers

    private static func group(_ symbols: String) -> String {
        let chars = Array(symbols)
        return stride(from: 0, to: chars.count, by: 4)
            .map { String(chars[$0..<min($0 + 4, chars.count)]) }
            .joined(separator: "-")
    }

    private static func normalize(_ raw: String) -> String {
        String(raw.uppercased().compactMap { character -> Character? in
            switch character {
            case "-", " ": return nil
            case "O": return "0"
            case "I", "L": return "1"
            default: return character
            }
        })
    }

    private static func ipv4ToUInt32(_ ipv4: String) throws -> UInt32 {
        let octets = ipv4.split(separator: ".", omittingEmptySubsequences: false)
        guard octets.count == 4 else {
            throw LocatorCodeError.ipOutsideCGNAT
        }
        var address: UInt32 = 0
        for octet in octets {
            guard let value = UInt8(octet) else {
                throw LocatorCodeError.ipOutsideCGNAT
            }
            address = (address << 8) | UInt32(value)
        }
        return address
    }

    private static func uint32ToIPv4(_ address: UInt32) -> String {
        "\((address >> 24) & 0xFF).\((address >> 16) & 0xFF).\((address >> 8) & 0xFF).\(address & 0xFF)"
    }

    // The token canonical form is exactly 4 big-endian bytes with the top 2
    // bits zero, so host map keys and client requests agree on the byte shape.
    private static func tokenToUInt64(_ token: Data) -> UInt64 {
        token.reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
    }

    private static func tokenToData(_ token: UInt64) -> Data {
        var bigEndian = UInt32(token & UInt64(UInt32.max)).bigEndian
        return withUnsafeBytes(of: &bigEndian) { Data($0) }
    }

    // Mints a canonical 30-bit token from raw random bytes.
    static func makeFetchToken(from randomBytes: Data) -> Data {
        let raw = randomBytes.reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
        return tokenToData(raw & tokenMask)
    }
}
