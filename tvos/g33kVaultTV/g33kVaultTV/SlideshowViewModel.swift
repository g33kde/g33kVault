import Foundation
import Combine

/// Drives the native slideshow: polling in place of the web client's
/// Socket.IO live updates. There's no Swift Socket.IO client in this
/// project (avoiding an external SPM dependency for a first buildable pass
/// — see project.yml's other deferred-polish notes), so "live" here means
/// "within one poll interval" rather than instant. On a self-hosted LAN
/// server this is a reasonable trade-off; making it instant later is a good
/// next step (would need a Socket.IO client package).
@MainActor
final class SlideshowViewModel: ObservableObject {
    @Published private(set) var items: [MediaItem] = []
    @Published private(set) var currentIndex: Int = 0
    @Published private(set) var slideshowEnabled = true
    @Published private(set) var isLoading = true
    @Published private(set) var errorMessage: String?
    /// Non-nil exactly while the current slide is a highlighted new upload
    /// (mirrors the web client's "New Upload" badge — see
    /// client/src/pages/Slideshow.tsx).
    @Published private(set) var highlightItemId: String?

    private let api: MediaAPI
    private var imageDurationSeconds: TimeInterval = 6
    private var shuffle = false
    private var knownIds: Set<String> = []
    private var advanceTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?

    private static let pollInterval: TimeInterval = 4
    private static let newUploadDisplaySeconds: TimeInterval = 10

    var current: MediaItem? {
        guard !items.isEmpty else { return nil }
        return items[currentIndex % items.count]
    }

    init(api: MediaAPI) {
        self.api = api
    }

    func start() {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            await self?.pollLoop()
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
        advanceTask?.cancel()
        advanceTask = nil
    }

    /// Called by the view when the currently-displayed video finishes
    /// playing — mirrors the web `<video onEnded={advance}>` behavior.
    func videoDidFinish() {
        advance()
    }

    private func pollLoop() async {
        while !Task.isCancelled {
            await refresh()
            try? await Task.sleep(nanoseconds: UInt64(Self.pollInterval * 1_000_000_000))
        }
    }

    private func refresh() async {
        do {
            async let configFetch = api.fetchConfig()
            async let mediaFetch = api.fetchMedia()
            let (config, media) = try await (configFetch, mediaFetch)

            errorMessage = nil
            slideshowEnabled = config.slideshowEnabled
            imageDurationSeconds = config.slideshowIntervalMs / 1000

            if shuffle != config.shuffle {
                shuffle = config.shuffle
                applyFullReplace(media)
                return
            }

            if isLoading {
                applyFullReplace(media)
                isLoading = false
                return
            }

            applyIncrementalUpdate(media)
        } catch {
            errorMessage = "Can't reach the server. Retrying…"
        }
    }

    private func applyFullReplace(_ media: [MediaItem]) {
        items = shuffle ? media.shuffled() : media
        knownIds = Set(media.map(\.id))
        currentIndex = 0
        scheduleAdvanceIfNeeded()
    }

    /// Folds in additions/removals/edits from a fresh fetch without
    /// disturbing what's currently on screen — same intent as the web
    /// client's per-event socket handlers, just diffed against a snapshot
    /// instead of applied one event at a time.
    private func applyIncrementalUpdate(_ media: [MediaItem]) {
        let newIds = Set(media.map(\.id))
        let addedIds = newIds.subtracting(knownIds)
        let removedIds = knownIds.subtracting(newIds)
        knownIds = newIds

        let byId = Dictionary(uniqueKeysWithValues: media.map { ($0.id, $0) })
        let currentItemId = current?.id

        // Drop removed items, refresh edited ones (e.g. an admin rotation)
        // in place.
        var next = items.compactMap { existing -> MediaItem? in
            guard !removedIds.contains(existing.id) else { return nil }
            return byId[existing.id] ?? existing
        }

        let addedItems = media.filter { addedIds.contains($0.id) }
        let singleNewImage = addedItems.count == 1 && addedItems[0].isImage ? addedItems[0] : nil

        if let newImage = singleNewImage {
            // A single fresh photo jumps the queue and gets the highlight
            // treatment, exactly like the web client's non-interrupting
            // rule for everything else but this one case.
            let insertAt = min(currentIndex + 1, next.count)
            next.insert(newImage, at: insertAt)
            items = next
            currentIndex = insertAt
            highlightItemId = newImage.id
            scheduleAdvanceIfNeeded()
            return
        }

        // Everything else (videos, multi-item batch approvals) is queued in
        // quietly after the current slide, same as `media:approved` on web.
        let insertAt = min(currentIndex + 1, next.count)
        next.insert(contentsOf: addedItems, at: insertAt)
        items = next

        // Keep pointing at the same logical item if the list shifted under it.
        if let currentItemId, let idx = next.firstIndex(where: { $0.id == currentItemId }) {
            currentIndex = idx
        } else if next.isEmpty {
            currentIndex = 0
        } else {
            currentIndex = currentIndex % next.count
        }
    }

    private func scheduleAdvanceIfNeeded() {
        advanceTask?.cancel()
        guard let current else { return }

        // Videos advance on playback completion (see videoDidFinish), not a
        // timer — except while showing the highlight treatment, which is
        // always time-boxed regardless of media kind, matching the web
        // client's NEW_UPLOAD_DISPLAY_MS override.
        let isHighlighted = highlightItemId == current.id
        guard isHighlighted || current.isImage else { return }

        let duration = isHighlighted ? Self.newUploadDisplaySeconds : imageDurationSeconds
        advanceTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(duration * 1_000_000_000))
            guard !Task.isCancelled else { return }
            self?.advance()
        }
    }

    private func advance() {
        guard !items.isEmpty else { return }
        if highlightItemId == current?.id {
            highlightItemId = nil
        }
        let next = (currentIndex + 1) % items.count
        if next == 0 && shuffle {
            items.shuffle()
        }
        currentIndex = next
        scheduleAdvanceIfNeeded()
    }
}
