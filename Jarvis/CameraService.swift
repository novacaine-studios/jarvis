import AVFoundation
import CoreImage
import SwiftUI

/// Keeps the back camera running while the app is open and holds on to the newest frame.
/// Nothing is uploaded until you ask Jarvis a question.
final class CameraService: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    let session = AVCaptureSession()

    private let queue = DispatchQueue(label: "jarvis.camera")
    private let lock = NSLock()
    private let ciContext = CIContext()
    private var latestFrame: CIImage?
    private var latestFrameAt = Date.distantPast
    private var configured = false

    func start() {
        queue.async { [self] in
            if !configured { configure() }
            if !session.isRunning { session.startRunning() }
        }
    }

    func stop() {
        queue.async { [self] in session.stopRunning() }
    }

    /// The newest frame as a JPEG (longest side 1280px), or nil if the camera isn't live,
    /// e.g. when the app is in the background, where iOS turns the camera off.
    func latestJPEG(maxAge: TimeInterval = 3) -> Data? {
        lock.lock()
        let frame = latestFrame
        let takenAt = latestFrameAt
        lock.unlock()
        guard let frame, Date().timeIntervalSince(takenAt) < maxAge else { return nil }

        let longest = max(frame.extent.width, frame.extent.height)
        let scale = min(1, 1280 / longest)
        let resized = frame.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        return ciContext.jpegRepresentation(
            of: resized,
            colorSpace: CGColorSpaceCreateDeviceRGB(),
            options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.7]
        )
    }

    private func configure() {
        session.beginConfiguration()
        session.sessionPreset = .hd1920x1080
        if let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back),
           let input = try? AVCaptureDeviceInput(device: camera),
           session.canAddInput(input) {
            session.addInput(input)
        }
        let output = AVCaptureVideoDataOutput()
        output.alwaysDiscardsLateVideoFrames = true
        output.setSampleBufferDelegate(self, queue: queue)
        if session.canAddOutput(output) {
            session.addOutput(output)
            if let connection = output.connection(with: .video), connection.isVideoRotationAngleSupported(90) {
                connection.videoRotationAngle = 90 // portrait
            }
        }
        session.commitConfiguration()
        configured = true
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let image = CIImage(cvPixelBuffer: pixels)
        lock.lock()
        latestFrame = image
        latestFrameAt = Date()
        lock.unlock()
    }
}

struct CameraPreview: UIViewRepresentable {
    let session: AVCaptureSession

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = session
        view.previewLayer.videoGravity = .resizeAspectFill
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {}
}
