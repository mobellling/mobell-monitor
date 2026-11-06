import Foundation
import PhotosUI
import UIKit
import UniformTypeIdentifiers
import WebKit

/// Handles `<input type="file">` inside the WKWebView.
///
/// WKWebView does not show a file picker unless its `uiDelegate` implements
/// `webView(_:runOpenPanelWith:initiatedByFrame:completionHandler:)`.
/// We offer either the photo library (PHPicker, multi-select) or the Files app.
@MainActor
final class FilePicker: NSObject, WKUIDelegate {
    weak var webView: WKWebView?

    private var completion: (([URL]?) -> Void)?
    private var allowsMultiple = false

    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        self.completion = completionHandler
        self.allowsMultiple = parameters.allowsMultipleSelection
        presentChoice()
    }

    private func presentChoice() {
        guard let presenter = topViewController() else {
            finish(nil)
            return
        }
        let alert = UIAlertController(title: "选择图片或文件", message: nil, preferredStyle: .actionSheet)
        alert.addAction(UIAlertAction(title: "照片图库", style: .default) { [weak self] _ in
            self?.presentPhotoPicker(from: presenter)
        })
        alert.addAction(UIAlertAction(title: "文件", style: .default) { [weak self] _ in
            self?.presentDocumentPicker(from: presenter)
        })
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { [weak self] _ in
            self?.finish(nil)
        })
        if let popover = alert.popoverPresentationController {
            popover.sourceView = presenter.view
            popover.sourceRect = CGRect(
                x: presenter.view.bounds.midX,
                y: presenter.view.bounds.midY,
                width: 1,
                height: 1
            )
        }
        presenter.present(alert, animated: true)
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

    private func finish(_ urls: [URL]?) {
        let callback = completion
        completion = nil
        callback?(urls)
    }

    /// Re-encodes photos to JPEG so the web layer never has to deal with HEIC,
    /// and keeps files comfortably below the app's 5 MB limit.
    private static func jpegData(_ image: UIImage, maxEdge: CGFloat = 2400) -> Data? {
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
        var quality: CGFloat = 0.88
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
        guard completion != nil else { return }
        guard !results.isEmpty else {
            finish(nil)
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
                var urls: [URL] = []
                for image in images {
                    guard let data = Self.jpegData(image) else { continue }
                    let url = FileManager.default.temporaryDirectory
                        .appendingPathComponent(UUID().uuidString)
                        .appendingPathExtension("jpg")
                    do {
                        try data.write(to: url, options: .atomic)
                        urls.append(url)
                    } catch {
                        continue
                    }
                }
                self.finish(urls.isEmpty ? nil : urls)
            }
        }
    }
}

extension FilePicker: UIDocumentPickerDelegate {
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        finish(urls.isEmpty ? nil : urls)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finish(nil)
    }
}
