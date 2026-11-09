import Foundation
import ImageIO
import Vision

for path in CommandLine.arguments.dropFirst() {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        fputs("Could not open receipt image: \(path)\n", stderr)
        exit(2)
    }

    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = false
    request.recognitionLanguages = ["en-US"]
    try VNImageRequestHandler(cgImage: image).perform([request])

    let lines = (request.results ?? []).compactMap { observation -> (CGFloat, String)? in
        guard let text = observation.topCandidates(1).first?.string else { return nil }
        return (observation.boundingBox.midY, text)
    }.sorted { $0.0 > $1.0 }

    print("=== \(URL(fileURLWithPath: path).lastPathComponent) ===")
    for (_, line) in lines {
        print(line)
    }
}
