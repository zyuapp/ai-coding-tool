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
            VStack(spacing: 28) {
                VStack(spacing: 16) {
                    Image(systemName: "laptopcomputer.and.iphone")
                        .font(.system(size: 34, weight: .medium))
                        .foregroundStyle(.white)
                        .frame(width: 84, height: 84)
                        .background(
                            LinearGradient(colors: [palette.accent, palette.accent.opacity(0.78)], startPoint: .topLeading, endPoint: .bottomTrailing),
                            in: RoundedRectangle(cornerRadius: 24, style: .continuous)
                        )
                        .shadow(color: palette.accent.opacity(0.35), radius: 18, y: 8)
                        .accessibilityHidden(true)
                    VStack(spacing: 8) {
                        Text("Pair with Your Computer")
                            .font(.title.weight(.bold))
                            .foregroundStyle(palette.ink)
                            .multilineTextAlignment(.center)
                        Text(model.state.notice ?? MobileClient.scanAgain)
                            .font(.body)
                            .foregroundStyle(palette.inkDim)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                VStack(alignment: .leading, spacing: 0) {
                    step(1, "Open **AI Coding Tool** on your computer.")
                    palette.lineSoft.frame(height: 1).padding(.leading, 52)
                    step(2, "Go to **Settings › Devices**.")
                    palette.lineSoft.frame(height: 1).padding(.leading, 52)
                    step(3, DataScannerViewController.isSupported ? "Choose **Pair a phone**, then scan the code." : "Choose **Pair a phone**, then paste its link below.")
                }
                .background(palette.surface, in: RoundedRectangle(cornerRadius: 20, style: .continuous))

                VStack(spacing: 12) {
                    if DataScannerViewController.isSupported {
                        Button { scanning = true } label: {
                            Label("Scan QR Code", systemImage: "qrcode.viewfinder")
                                .font(.body.weight(.semibold))
                                .frame(maxWidth: .infinity, minHeight: 50)
                                .foregroundStyle(palette.accentInk)
                                .background(palette.accent, in: Capsule())
                                .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                    }

                    HStack(spacing: 8) {
                        Image(systemName: "link").font(.subheadline.weight(.semibold)).foregroundStyle(palette.muted)
                        TextField("Pairing link", text: $link)
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
                        .tint(palette.mutedStrong)
                        .controlSize(.small)
                    }
                    .padding(.leading, 16)
                    .padding(.trailing, 8)
                    .frame(minHeight: 50)
                    .background(palette.surface, in: Capsule())
                    if !link.isEmpty, typedLink == nil {
                        Text("Not a pairing link. Copy it from your computer.").font(.footnote).foregroundStyle(palette.danger)
                    }
                    if !link.isEmpty || !DataScannerViewController.isSupported {
                        Button(action: pairWithLink) {
                            Text("Pair")
                                .font(.body.weight(.semibold))
                                .frame(maxWidth: .infinity, minHeight: 50)
                                .foregroundStyle(typedLink == nil ? palette.muted : palette.accentInk)
                                .background(typedLink == nil ? palette.raised : palette.accent, in: Capsule())
                                .contentShape(Capsule())
                        }
                        .buttonStyle(.plain)
                        .disabled(typedLink == nil)
                    }
                }

                if let origin {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Or type the code for \(origin.host() ?? "your computer")")
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(palette.muted)
                            .padding(.leading, 16)
                        HStack(spacing: 8) {
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
                            Button("Pair", action: pairWithCode)
                                .font(.subheadline.weight(.semibold))
                                .buttonStyle(.borderedProminent)
                                .buttonBorderShape(.capsule)
                                .disabled(typedCode == nil)
                        }
                        .padding(.leading, 16)
                        .padding(.trailing, 8)
                        .frame(minHeight: 50)
                        .background(palette.surface, in: Capsule())
                        if code.count == PairingLink.codeLength, typedCode == nil {
                            Text("Not a pairing code. Check it on your computer.").font(.footnote).foregroundStyle(palette.danger).padding(.leading, 16)
                        }
                    }
                }
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 32)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
            .containerRelativeFrame(.vertical, alignment: .center) { length, _ in length }
        }
        .scrollBounceBehavior(.basedOnSize)
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

    private func step(_ number: Int, _ text: LocalizedStringKey) -> some View {
        HStack(spacing: 14) {
            Text("\(number)")
                .font(.subheadline.weight(.bold).monospacedDigit())
                .foregroundStyle(palette.accent)
                .frame(width: 26, height: 26)
                .background(palette.accentChip, in: Circle())
            Text(text)
                .font(.subheadline)
                .foregroundStyle(palette.inkDim)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
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
