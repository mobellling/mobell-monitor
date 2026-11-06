import Foundation
import PhotosUI
import UIKit
import UniformTypeIdentifiers
import WebKit

/// Native file/photo picker for the iOS WKWebView.
///
/// WKWebView does not expose a usable file picker before iOS 18.4, so the web
/// layer calls `pickFiles` through the bridge instead of relying on
/// `<input type="file">`.
@MainActor
final class FilePicker: NSObject {
    weak var webView: WKWebView?

    private var filesCompletion: (([[String: Any]]) -> Void)?
    private var allowsMultiple = false

    func present(kind: String, multiple: Bool) async -> [[String: Any]] {
        await withCheckedContinuation { continuation in
            self.filesCompletion = { files in
                continuation.resume(returning: files)
            }
            self.allowsMultiple = multiple
            guard let presenter = topViewController() else {
                finishFiles([])
                return
            }
            if kind == "files" {
                presentDocumentPicker(from: presenter)
            } else {
                presentPhotoPicker(from: presenter)
            }
        }
    }

    private func presentPhotoPicker(from presenter: UIViewController) {
        var configuration = PHPickerConfiguration(photoLibrary: .shared())
        configuration.filter = .images
        configuration.selectionLimit = allowsMultiple ? 0 : 1
        configuration.preferredAssetRepresentationMode = .compatible
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = self
        presenter.present(picker, animated: true)
    }

    private func presentDocumentPicker(from presenter: UIViewController) {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
        picker.allowsMultipleSelection = allowsMultiple
        picker.delegate = self
        presenter.present(picker, animated: true)
    }

    private func topViewController() -> UIViewController? {
        var controller = webView?.window?.rootViewController
        while let presented = controller?.presentedViewController {
            controller = presented
        }
        if let navigation = controller as? UINavigationController {
            return navigation.visibleViewController
        }
        if let tab = controller as? UITabBarController {
            return tab.selectedViewController
        }
        return controller
    }

    private func finishFiles(_ files: [[String: Any]]) {
        let callback = filesCompletion
        filesCompletion = nil
        callback?(files)
    }

    /// Re-encodes photos to JPEG so the web layer never has to deal with HEIC,
    /// and keeps files comfortably below the app's 5 MB limit.
    private static func jpegData(_ image: UIImage, maxEdge: CGFloat = 2000) -> Data? {
        let longest = max(image.size.width, image.size.height)
        let scale = longest > maxEdge ? maxEdge / longest : 1
        let size = CGSize(
            width: max(1, (image.size.width * scale).rounded()),
            height: max(1, (image.size.height * scale).rounded())
        )
        let renderer = UIGraphicsImageRenderer(size: size)
        let resized = renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        var quality: CGFloat = 0.86
        var data = resized.jpegData(compressionQuality: quality)
        while let current = data, current.count > 4_500_000, quality > 0.45 {
            quality -= 0.1
            data = resized.jpegData(compressionQuality: quality)
        }
        return data
    }
}

extension FilePicker: PHPickerViewControllerDelegate {
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard filesCompletion != nil else { return }
        guard !results.isEmpty else {
            finishFiles([])
            return
        }

        let group = DispatchGroup()
        let lock = NSLock()
        var images: [UIImage] = []

        for result in results {
            let provider = result.itemProvider
            guard provider.canLoadObject(ofClass: UIImage.self) else { continue }
            group.enter()
            provider.loadObject(ofClass: UIImage.self) { object, _ in
                defer { group.leave() }
                guard let image = object as? UIImage else { return }
                lock.lock()
                images.append(image)
                lock.unlock()
            }
        }

        group.notify(queue: .main) {
            Task { @MainActor [weak self] in
                guard let self else { return }
                var files: [[String: Any]] = []
                for (index, image) in images.enumerated() {
                    guard let data = Self.jpegData(image) else { continue }
                    files.append([
                        "name": "image-\(index + 1).jpg",
                        "mime": "image/jpeg",
                        "dataBase64": data.base64EncodedString(),
                    ])
                }
                self.finishFiles(files)
            }
        }
    }
}

extension FilePicker: UIDocumentPickerDelegate {
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        var files: [[String: Any]] = []
        for url in urls {
            guard let data = try? Data(contentsOf: url) else { continue }
            let mime = UTType(filenameExtension: url.pathExtension)?.preferredMIMEType
                ?? "application/octet-stream"
            files.append([
                "name": url.lastPathComponent,
                "mime": mime,
                "dataBase64": data.base64EncodedString(),
            ])
        }
        finishFiles(files)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finishFiles([])
    }
}
