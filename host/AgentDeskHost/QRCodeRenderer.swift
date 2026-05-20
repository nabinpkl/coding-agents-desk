import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation

enum QRCodeRenderer {
    static func image(for url: URL, sideLength: CGFloat = 220) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(url.absoluteString.utf8)
        filter.correctionLevel = "H"
        guard let output = filter.outputImage else {
            return nil
        }

        let scale = sideLength / output.extent.width
        let transformed = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let representation = NSCIImageRep(ciImage: transformed)
        let image = NSImage(size: representation.size)
        image.addRepresentation(representation)
        return image
    }
}
