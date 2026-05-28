import XCTest
@testable import AgentDeskHost

final class WAVEncoderTests: XCTestCase {
    func testHeaderLayoutForMono16kHz() {
        let frames = 800 // 50 ms at 16 kHz
        let pcm = Data(repeating: 0, count: frames * 2)
        let wav = WAVEncoder.encode(pcm16LE: pcm, sampleRate: 16_000, channels: 1)

        XCTAssertEqual(wav.count, 44 + pcm.count)
        XCTAssertEqual(ascii(wav, 0, 4), "RIFF")
        XCTAssertEqual(ascii(wav, 8, 4), "WAVE")
        XCTAssertEqual(ascii(wav, 12, 4), "fmt ")
        XCTAssertEqual(ascii(wav, 36, 4), "data")

        XCTAssertEqual(u32(wav, 4), UInt32(36 + pcm.count))   // RIFF chunk size
        XCTAssertEqual(u32(wav, 16), 16)                       // PCM fmt size
        XCTAssertEqual(u16(wav, 20), 1)                        // PCM format tag
        XCTAssertEqual(u16(wav, 22), 1)                        // channels
        XCTAssertEqual(u32(wav, 24), 16_000)                   // sample rate
        XCTAssertEqual(u32(wav, 28), 32_000)                   // byte rate = 16000 * 1 * 2
        XCTAssertEqual(u16(wav, 32), 2)                        // block align
        XCTAssertEqual(u16(wav, 34), 16)                       // bits per sample
        XCTAssertEqual(u32(wav, 40), UInt32(pcm.count))        // data size
    }

    func testSamplesAppendedVerbatim() {
        let samples: [Int16] = [0, 1, -1, 32767, -32768, 1234]
        var pcm = Data()
        for s in samples {
            var le = s.littleEndian
            withUnsafeBytes(of: &le) { pcm.append(contentsOf: $0) }
        }
        let wav = WAVEncoder.encode(pcm16LE: pcm, sampleRate: 16_000, channels: 1)
        XCTAssertEqual(wav.suffix(pcm.count), pcm)
    }

    private func ascii(_ data: Data, _ offset: Int, _ length: Int) -> String {
        String(decoding: data[data.startIndex + offset ..< data.startIndex + offset + length], as: UTF8.self)
    }

    private func u32(_ data: Data, _ offset: Int) -> UInt32 {
        let b = data.startIndex + offset
        return UInt32(data[b]) | UInt32(data[b + 1]) << 8 | UInt32(data[b + 2]) << 16 | UInt32(data[b + 3]) << 24
    }

    private func u16(_ data: Data, _ offset: Int) -> UInt16 {
        let b = data.startIndex + offset
        return UInt16(data[b]) | UInt16(data[b + 1]) << 8
    }
}
