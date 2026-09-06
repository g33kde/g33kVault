import Foundation

/// Mirrors the subset of `MediaRow` (server/src/db.ts) the slideshow needs.
/// Decoding ignores any JSON fields not listed here (phash, content_hash,
/// batchId, etc.) — Codable only requires the properties actually declared.
struct MediaItem: Codable, Identifiable, Equatable {
    let id: String
    let filename: String
    let mimeType: String
    let kind: String
    let createdAt: Double
    let size: Int
    let uploader: String?
    let photoTakenAt: Double?

    enum CodingKeys: String, CodingKey {
        case id, filename, kind, size, uploader
        case mimeType = "mime_type"
        case createdAt = "created_at"
        case photoTakenAt = "photo_taken_at"
    }

    var isImage: Bool { kind == "image" }
    var isVideo: Bool { kind == "video" }
}

/// Mirrors the fields of `GET /api/config` this app actually uses. Collage
/// layouts, transitions and Party Mode (see client/src/pages/Slideshow.tsx)
/// are deliberately not reimplemented in this first native pass — plain
/// single-photo/video rotation only, same as the web slideshow's fallback
/// behavior with collage mode off.
struct SlideshowConfig: Codable {
    let slideshowIntervalMs: Double
    let shuffle: Bool
    let slideshowEnabled: Bool
}
