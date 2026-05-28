import Foundation

// Wraps raw little-endian 16-bit PCM samples in a canonical 44-byte WAV
// header so a transcription server can read the clip without a container
// probe. Kept free of AVFoundation so the byte layout is unit-testable
// without a live audio engine.
enum WAVEncoder {
    static func encode(pcm16LE: Data, sampleRate: Int, channels: Int = 1) -> Data {
        let bitsPerSample = 16
        let byteRate = sampleRate * channels * bitsPerSample / 8
        let blockAlign = channels * bitsPerSample / 8
        let dataSize = pcm16LE.count

        var out = Data(capacity: 44 + dataSize)
        out.appendASCII("RIFF")
        out.appendLE(UInt32(36 + dataSize))     // RIFF chunk size
        out.appendASCII("WAVE")
        out.appendASCII("fmt ")
        out.appendLE(UInt32(16))                 // fmt subchunk size (PCM)
        out.appendLE(UInt16(1))                  // audio format: PCM
        out.appendLE(UInt16(channels))
        out.appendLE(UInt32(sampleRate))
        out.appendLE(UInt32(byteRate))
        out.appendLE(UInt16(blockAlign))
        out.appendLE(UInt16(bitsPerSample))
        out.appendASCII("data")
        out.appendLE(UInt32(dataSize))
        out.append(pcm16LE)
        return out
    }
}

private extension Data {
    mutating func appendASCII(_ string: String) {
        append(contentsOf: string.utf8)
    }

    mutating func appendLE<T: FixedWidthInteger>(_ value: T) {
        var le = value.littleEndian
        Swift.withUnsafeBytes(of: &le) { append(contentsOf: $0) }
    }
}
