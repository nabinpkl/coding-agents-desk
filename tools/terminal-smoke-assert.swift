#!/usr/bin/env swift
import CoreGraphics
import Foundation
import ImageIO
import Vision

let usage = "usage: terminal-smoke-assert.swift <screenshot-path> <expected-text>"

guard CommandLine.arguments.count == 3 else {
    fputs("\(usage)\n", stderr)
    exit(2)
}

let screenshotPath = CommandLine.arguments[1]
let expectedText = CommandLine.arguments[2]
let screenshotURL = URL(fileURLWithPath: screenshotPath)

guard
    let imageSource = CGImageSourceCreateWithURL(screenshotURL as CFURL, nil),
    let screenshot = CGImageSourceCreateImageAtIndex(imageSource, 0, nil)
else {
    fputs("terminal-smoke: failed to load screenshot at \(screenshotPath)\n", stderr)
    exit(2)
}

var recognizedLines: [String] = []
var recognitionError: Error?

let request = VNRecognizeTextRequest { request, error in
    recognitionError = error
    let observations = (request.results as? [VNRecognizedTextObservation]) ?? []
    recognizedLines = observations.compactMap { observation in
        observation.topCandidates(1).first?.string
    }
}
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false

do {
    let handler = VNImageRequestHandler(cgImage: screenshot, options: [:])
    try handler.perform([request])
} catch {
    fputs("terminal-smoke: OCR failed: \(error)\n", stderr)
    exit(2)
}

if let recognitionError {
    fputs("terminal-smoke: OCR failed: \(recognitionError)\n", stderr)
    exit(2)
}

let recognizedText = recognizedLines.joined(separator: "\n")
if recognizedText.contains(expectedText) {
    print("terminal-smoke: found \(expectedText)")
    exit(0)
}

fputs("terminal-smoke: expected text not found: \(expectedText)\n", stderr)
fputs("--- recognized text ---\n\(recognizedText)\n", stderr)
exit(1)
