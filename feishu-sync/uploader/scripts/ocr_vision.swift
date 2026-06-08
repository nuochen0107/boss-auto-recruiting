#!/usr/bin/env swift

import CoreGraphics
import Foundation
import ImageIO
import Vision

if CommandLine.arguments.count != 2 {
    fputs("usage: ocr_vision.swift <image>\n", stderr)
    exit(2)
}

let imageURL = URL(fileURLWithPath: CommandLine.arguments[1])
guard let source = CGImageSourceCreateWithURL(imageURL as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    exit(3)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = true
request.recognitionLanguages = ["zh-Hans", "en-US"]

let handler = VNImageRequestHandler(cgImage: image, options: [:])
do {
    try handler.perform([request])
} catch {
    fputs("\(error)\n", stderr)
    exit(4)
}

let observations = (request.results ?? []).sorted {
    let dy = abs($0.boundingBox.midY - $1.boundingBox.midY)
    if dy > 0.01 {
        return $0.boundingBox.midY > $1.boundingBox.midY
    }
    return $0.boundingBox.minX < $1.boundingBox.minX
}

for observation in observations {
    guard let text = observation.topCandidates(1).first?.string else {
        continue
    }
    print(text)
}
