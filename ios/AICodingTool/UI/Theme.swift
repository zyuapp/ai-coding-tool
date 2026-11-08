import SwiftUI
import UIKit

/// The desktop's theme as the phone wears it: the primitives from `Themes.json`, which
/// `scripts/generate-ios-themes.mts` writes from the desktop's own `themes.css`, and the tokens the
/// phone page derives from them in `mobile.css`.
struct Palette: Equatable {
    let id: String
    let dark: Bool
    private let colors: [String: RGB]

    struct RGB: Equatable {
        var red: Double
        var green: Double
        var blue: Double

        init(red: Double, green: Double, blue: Double) {
            self.red = red
            self.green = green
            self.blue = blue
        }

        init?(hex: String) {
            var digits = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
            if digits.count == 3 || digits.count == 4 { digits = digits.map { "\($0)\($0)" }.joined() }
            guard digits.count == 6 || digits.count == 8, let value = UInt64(digits.prefix(6), radix: 16) else { return nil }
            red = Double((value >> 16) & 0xff) / 255
            green = Double((value >> 8) & 0xff) / 255
            blue = Double(value & 0xff) / 255
        }

        /// `color-mix(in srgb, self share%, other)`.
        func mixed(_ share: Double, _ other: RGB) -> RGB {
            RGB(red: red * share + other.red * (1 - share), green: green * share + other.green * (1 - share), blue: blue * share + other.blue * (1 - share))
        }

        var color: Color { Color(red: red, green: green, blue: blue) }
    }

    private func raw(_ name: String) -> RGB {
        colors[name] ?? colors["fg-0"] ?? RGB(red: 0.5, green: 0.5, blue: 0.5)
    }

    private func value(_ name: String, or fallback: String) -> RGB {
        colors[name] ?? raw(fallback)
    }

    var canvas: Color { raw("bg-0").color }
    var sunken: Color { raw("bg-1").color }
    var surface: Color { raw("bg-2").color }
    var menu: Color { raw("bg-3").color }
    var raised: Color { raw("bg-4").color }
    var active: Color { raw("bg-5").color }
    var line: Color { raw("line-1").color }
    var lineSoft: Color { raw("line-0").color }
    var lineStrong: Color { raw("line-2").color }
    var ink: Color { raw("fg-0").color }
    var inkSoft: Color { raw("fg-0").mixed(0.6, raw("fg-1")).color }
    var inkDim: Color { raw("fg-1").color }
    var mutedStrong: Color { raw("fg-2").color }
    var muted: Color { raw("fg-3").color }
    var quiet: Color { raw("fg-4").color }
    var quietSoft: Color { raw("fg-5").color }
    var accent: Color { raw("accent").color }
    var accentInk: Color { raw("accent-ink").color }
    var accentSurface: Color { raw("accent").mixed(0.09, raw("bg-0")).color }
    var accentChip: Color { raw("accent").mixed(0.17, raw("bg-1")).color }
    var accentLine: Color { raw("accent").mixed(0.32, raw("bg-5")).color }
    var success: Color { value("success-text", or: "success").color }
    var danger: Color { value("danger-text", or: "danger").color }
    var dangerSurface: Color { raw("danger").mixed(0.10, raw("bg-1")).color }
    var info: Color { value("info-text", or: "info").color }
    var warning: Color { raw("warning").color }
    var link: Color { raw("link").color }
    var contrast: Color { raw("contrast").color }
    var contrastInk: Color { raw("contrast-ink").color }
    var codeSurface: Color { raw("bg-4").color }
    var codeInk: Color { raw("ansi-white").color }
    var diffAddSurface: Color { raw("success").mixed(0.12, raw("bg-0")).color }
    var diffAddGutter: Color { raw("success").mixed(0.18, raw("bg-1")).color }
    var diffDeleteSurface: Color { raw("danger").mixed(0.12, raw("bg-0")).color }
    var diffDeleteGutter: Color { raw("danger").mixed(0.18, raw("bg-1")).color }
    var hunkSurface: Color { raw("info").mixed(0.08, raw("bg-1")).color }

    var scheme: ColorScheme { dark ? .dark : .light }

    static let all: [String: Palette] = {
        guard let url = Bundle.main.url(forResource: "Themes", withExtension: "json"), let data = try? Data(contentsOf: url), let themes = try? JSONDecoder().decode([String: [String: String]].self, from: data) else { return [:] }
        return themes.reduce(into: [:]) { result, entry in
            let colors = entry.value.compactMapValues(RGB.init(hex:))
            result[entry.key] = Palette(id: entry.key, dark: entry.value["color-scheme"] != "light", colors: colors)
        }
    }()

    static let fallbackDark = all["aicodingtool-dark"] ?? Palette(id: "aicodingtool-dark", dark: true, colors: [:])
    static let fallbackLight = all["aicodingtool-light"] ?? Palette(id: "aicodingtool-light", dark: false, colors: [:])

    /// The face the phone wears: the desktop's own when it chose one, the phone's appearance on "auto".
    static func resolve(_ theme: MobileTheme, systemDark: Bool) -> Palette {
        let dark = theme.mode == "auto" ? systemDark : theme.mode != "light"
        return all[dark ? theme.dark : theme.light] ?? (dark ? fallbackDark : fallbackLight)
    }
}

private struct PaletteKey: EnvironmentKey {
    static let defaultValue = Palette.fallbackDark
}

extension EnvironmentValues {
    var palette: Palette {
        get { self[PaletteKey.self] }
        set { self[PaletteKey.self] = newValue }
    }
}
