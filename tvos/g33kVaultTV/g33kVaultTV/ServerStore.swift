import Foundation
import Combine

/// Persists the self-hosted g33kVault server's address and turns it into a
/// base URL for the REST API. There's no fixed backend for this app to talk
/// to (unlike an app backed by a cloud API) — every g33kVault instance is a
/// different address on someone's own network, so this is the one piece of
/// setup a viewer has to do once, on first launch.
final class ServerStore: ObservableObject {
    private static let storageKey = "g33kvault.serverAddress"

    /// What the user actually typed (e.g. "192.168.1.42:3000" or a full
    /// "http://host:3000") — kept as entered so re-opening Settings shows
    /// back exactly what they typed, not a normalized/guessed version.
    @Published var address: String {
        didSet {
            UserDefaults.standard.set(address, forKey: Self.storageKey)
        }
    }

    init() {
        self.address = UserDefaults.standard.string(forKey: Self.storageKey) ?? ""
    }

    var hasAddress: Bool {
        !address.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The server's root URL, used as the base for the REST calls
    /// SlideshowViewModel/MediaAPI make (`/api/media`, `/api/config`,
    /// `/media/<filename>`). Guests type just a host[:port] almost
    /// universally (this app's whole reason to exist is pointing at a
    /// plain-HTTP LAN server, not a public HTTPS one), so a missing scheme
    /// defaults to http:// rather than making that required typing on a
    /// Siri Remote keyboard. Still honors an explicit http://\/https:// if
    /// someone pastes a full URL.
    var baseURL: URL? {
        let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let withScheme: String
        if trimmed.lowercased().hasPrefix("http://") || trimmed.lowercased().hasPrefix("https://") {
            withScheme = trimmed
        } else {
            withScheme = "http://\(trimmed)"
        }

        return URL(string: withScheme)
    }
}
