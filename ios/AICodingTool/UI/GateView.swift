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
    @State private var viewport: CGFloat = 0
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
                        .font(.system(size: 30, weight: .medium))
                        .foregroundStyle(palette.accent)
                        .frame(width: 76, height: 76)
                        .background(palette.accentChip, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(palette.accentLine))
                        .accessibilityHidden(true)
                    VStack(spacing: Space.s) {
                        Text("Pair with Your Computer")
                            .font(.title.weight(.semibold))
                            .tracking(-0.4)
                            .foregroundStyle(palette.ink)
                            .multilineTextAlignment(.center)
                        Text(model.state.notice ?? MobileClient.scanAgain)
                            .font(.body)
                            .foregroundStyle(palette.muted)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                VStack(alignment: .leading, spacing: 0) {
                    step(1, "Open **AI Coding Tool** on your computer.")
                    palette.lineSoft.frame(height: 1).padding(.leading, 50)
                    step(2, "Go to **Settings › Devices**.")
                    palette.lineSoft.frame(height: 1).padding(.leading, 50)
                    step(3, DataScannerViewController.isSupported ? "Choose **Pair a phone**, then scan the code." : "Choose **Pair a phone**, then paste its link below.")
                }
                .background(palette.surface, in: RoundedRectangle(cornerRadius: Radius.bubble, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Radius.bubble, style: .continuous).strokeBorder(palette.lineSoft))

                VStack(spacing: Space.m) {
                    if DataScannerViewController.isSupported {
                        Button { scanning = true } label: {
                            ActionLabel(title: "Scan QR Code", symbol: "qrcode.viewfinder")
                        }
                        .buttonStyle(.press)
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
                    .overlay(Capsule().strokeBorder(focused ? palette.lineStrong : palette.lineSoft))
                    .animation(.touch, value: focused)
                    if !link.isEmpty, typedLink == nil {
                        Text("Not a pairing link. Copy it from your computer.").font(.footnote).foregroundStyle(palette.danger)
                    }
                    if !link.isEmpty {
                        Button(action: pairWithLink) {
                            ActionLabel(title: "Pair", enabled: typedLink != nil)
                        }
                        .buttonStyle(.press)
                        .disabled(typedLink == nil)
                        .transition(.rise)
                    }
                }
                .animation(.glide, value: link.isEmpty)

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
                                .tint(palette.accent)
                                .disabled(typedCode == nil)
                        }
                        .padding(.leading, 16)
                        .padding(.trailing, 8)
                        .frame(minHeight: 50)
                        .background(palette.surface, in: Capsule())
                        .overlay(Capsule().strokeBorder(palette.lineSoft))
                        if code.count == PairingLink.codeLength, typedCode == nil {
                            Text("Not a pairing code. Check it on your computer.").font(.footnote).foregroundStyle(palette.danger).padding(.leading, 16)
                        }
                    }
                }
            }
            .padding(.horizontal, Space.page)
            .padding(.vertical, 32)
            .frame(maxWidth: 480)
            .frame(maxWidth: .infinity)
            .frame(minHeight: viewport)
        }
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewport = $0 }
        .scrollBounceBehavior(.basedOnSize)
        .scrollDismissesKeyboard(.interactively)
        .background(palette.canvas.ignoresSafeArea())
        .fullScreenCover(isPresented: $scanning) {
            NavigationStack {
                QRScanner { text in
                    guard let link = PairingLink(text) else { return false }
                    scanning = false
                    model.connection.pair(with: link)
                    return true
                }
                .ignoresSafeArea()
                .navigationTitle("Scan Pairing Code")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { SheetClose { scanning = false } }
            }
        }
    }

    private func step(_ number: Int, _ text: LocalizedStringKey) -> some View {
        HStack(spacing: Space.m) {
            Text("\(number)")
                .font(.footnote.weight(.semibold).monospacedDigit())
                .foregroundStyle(palette.mutedStrong)
                .frame(width: 26, height: 26)
                .background(palette.raised, in: Circle())
            Text(text)
                .font(.subheadline)
                .foregroundStyle(palette.inkDim)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Space.m)
        .padding(.vertical, 13)
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
