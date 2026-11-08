import SwiftUI
import VisionKit

/// A phone with no token: scan the computer's QR code, paste its link, or type the code beside the
/// QR once the phone knows which computer to ask.
struct GateView: View {
    var model: PhoneModel
    @Environment(\.palette) private var palette
    @State private var link = ""
    @State private var code = ""
    @State private var scanning = false
    @FocusState private var focused: Bool

    private var origin: URL? { model.connection.origin }
    private var typedLink: PairingLink? { PairingLink(link) }
    private var typedCode: PairingLink? {
        guard let origin, let code = PairingLink.code(PairingLink.normalized(code)) else { return nil }
        var components = URLComponents(url: origin, resolvingAgainstBaseURL: false)
        components?.path = "/m/"
        components?.fragment = "pair=\(code)"
        return components?.url.flatMap { PairingLink($0.absoluteString) }
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                Image(systemName: "qrcode.viewfinder")
                    .font(.system(size: 48, weight: .light))
                    .foregroundStyle(palette.accent)
                    .padding(.top, 56)
                Text("AI Coding Tool").font(.title2.weight(.semibold)).foregroundStyle(palette.ink)
                Text(model.state.notice ?? MobileClient.scanAgain)
                    .font(.body)
                    .foregroundStyle(palette.inkDim)
                    .multilineTextAlignment(.center)
                Text("Settings › Devices › Pair a phone")
                    .font(.footnote)
                    .foregroundStyle(palette.muted)

                if DataScannerViewController.isSupported {
                    Button { scanning = true } label: {
                        Label("Scan QR code", systemImage: "camera.viewfinder").frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .padding(.top, 8)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Pairing link").font(.footnote.weight(.semibold)).foregroundStyle(palette.muted)
                    HStack {
                        TextField("https://…/m/#pair=…", text: $link)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                            .submitLabel(.go)
                            .focused($focused)
                            .onSubmit(pairWithLink)
                            .accessibilityLabel("Pairing link")
                        PasteButton(payloadType: String.self) { strings in
                            if let first = strings.first { link = first }
                        }
                        .labelStyle(.iconOnly)
                        .buttonBorderShape(.capsule)
                    }
                    .padding(12)
                    .background(palette.surface, in: RoundedRectangle(cornerRadius: 12))
                    if !link.isEmpty, typedLink == nil {
                        Text("Not a pairing link. Copy it from your computer.").font(.footnote).foregroundStyle(palette.danger)
                    }
                    Button("Pair", action: pairWithLink)
                        .buttonStyle(.bordered)
                        .disabled(typedLink == nil)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
                .padding(.top, 8)

                if let origin {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Or type the code for \(origin.host() ?? "your computer")").font(.footnote.weight(.semibold)).foregroundStyle(palette.muted)
                        HStack {
                            TextField("8-character code", text: $code)
                                .textInputAutocapitalization(.characters)
                                .autocorrectionDisabled()
                                .textContentType(.oneTimeCode)
                                .font(.body.monospaced())
                                .onChange(of: code) { _, next in
                                    let normalized = PairingLink.normalized(next)
                                    if normalized != next { code = normalized }
                                }
                                .onSubmit(pairWithCode)
                                .accessibilityLabel("Pairing code")
                            Button("Pair", action: pairWithCode).disabled(typedCode == nil)
                        }
                        .padding(12)
                        .background(palette.surface, in: RoundedRectangle(cornerRadius: 12))
                        if code.count == PairingLink.codeLength, typedCode == nil {
                            Text("Not a pairing code. Check it on your computer.").font(.footnote).foregroundStyle(palette.danger)
                        }
                    }
                }
            }
            .padding(.horizontal, 24)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(palette.canvas.ignoresSafeArea())
        .sheet(isPresented: $scanning) {
            QRScanner { text in
                guard let link = PairingLink(text) else { return false }
                scanning = false
                model.connection.pair(with: link)
                return true
            }
            .ignoresSafeArea()
        }
    }

    private func pairWithLink() {
        guard let typedLink else { return }
        focused = false
        model.connection.pair(with: typedLink)
    }

    private func pairWithCode() {
        guard let typedCode else { return }
        model.connection.pair(with: typedCode)
    }
}

/// The camera, reading QR codes until one is a pairing link.
struct QRScanner: UIViewControllerRepresentable {
    var onCode: (String) -> Bool

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let scanner = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, isHighlightingEnabled: true)
        scanner.delegate = context.coordinator
        try? scanner.startScanning()
        return scanner
    }

    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Bool
        private var done = false

        init(onCode: @escaping (String) -> Bool) {
            self.onCode = onCode
        }

        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            guard !done else { return }
            for item in addedItems {
                if case .barcode(let barcode) = item, let text = barcode.payloadStringValue, onCode(text) {
                    done = true
                    dataScanner.stopScanning()
                    return
                }
            }
        }
    }
}
