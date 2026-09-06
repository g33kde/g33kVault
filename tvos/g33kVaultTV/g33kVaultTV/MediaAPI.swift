import Foundation

enum MediaAPIError: Error {
    case badResponse
}

/// Thin fetch layer over the same two endpoints the web slideshow reads
/// (`/api/media`, `/api/config`) — no Socket.IO client here (see
/// SlideshowViewModel's polling note), just plain HTTP GETs against the
/// self-hosted server the user pointed this app at in Settings.
struct MediaAPI {
    let baseURL: URL

    func fetchMedia() async throws -> [MediaItem] {
        try await get([MediaItem].self, path: "/api/media")
    }

    func fetchConfig() async throws -> SlideshowConfig {
        try await get(SlideshowConfig.self, path: "/api/config")
    }

    /// `GET /media/<filename>` is served as-is by Express's static
    /// middleware (server/src/index.ts) — no `/api` prefix, unlike the JSON
    /// endpoints above.
    func mediaFileURL(for item: MediaItem) -> URL? {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        components?.path = "/media/\(item.filename)"
        return components?.url
    }

    private func get<T: Decodable>(_ type: T.Type, path: String) async throws -> T {
        var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        components?.path = path
        guard let url = components?.url else { throw MediaAPIError.badResponse }

        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw MediaAPIError.badResponse
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}
