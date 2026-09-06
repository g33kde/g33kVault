import SwiftUI
import AVKit

/// Native reimplementation of the web `/slideshow` page's core experience —
/// tvOS has no WKWebView (verified: WebKit.framework isn't part of the tvOS
/// SDK at all, unlike iOS/macOS/visionOS), so embedding the existing page
/// isn't possible on this platform. This covers single photo/video rotation
/// with the "New Upload" highlight, matching client/src/pages/Slideshow.tsx;
/// collage layouts, transitions and Party Mode are deliberately not
/// reimplemented in this first pass (see SlideshowViewModel/config comments)
/// — a good next step once the core app is confirmed working.
struct SlideshowView: View {
    let baseURL: URL
    /// Lets the parent (ContentView) hand back control to Settings when the
    /// Siri Remote's Menu/Back button is pressed — the slideshow itself has
    /// no on-screen UI to interact with otherwise.
    let onRequestSettings: () -> Void

    @StateObject private var viewModel: SlideshowViewModel

    init(baseURL: URL, onRequestSettings: @escaping () -> Void) {
        self.baseURL = baseURL
        self.onRequestSettings = onRequestSettings
        _viewModel = StateObject(wrappedValue: SlideshowViewModel(api: MediaAPI(baseURL: baseURL)))
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            if !viewModel.slideshowEnabled {
                messageScreen("Slideshow is currently disabled.")
            } else if let current = viewModel.current {
                SlideView(
                    item: current,
                    fileURL: MediaAPI(baseURL: baseURL).mediaFileURL(for: current),
                    isHighlighted: viewModel.highlightItemId == current.id,
                    onVideoFinished: { viewModel.videoDidFinish() }
                )
                .id(current.id)
            } else if viewModel.isLoading {
                ProgressView().tint(.white)
            } else {
                messageScreen("Waiting for the first upload…")
            }

            if let errorMessage = viewModel.errorMessage {
                errorOverlay(errorMessage)
            }
        }
        .onExitCommand {
            onRequestSettings()
        }
        .onAppear { viewModel.start() }
        .onDisappear { viewModel.stop() }
    }

    private func messageScreen(_ text: String) -> some View {
        VStack(spacing: 12) {
            Text("g33kVault").font(.system(size: 40, weight: .bold, design: .monospaced))
            Text(text).foregroundStyle(.secondary)
        }
        .foregroundStyle(.white)
    }

    private func errorOverlay(_ message: String) -> some View {
        VStack(spacing: 16) {
            Text("Can't reach the server").font(.title2).bold()
            Text(message).font(.caption).foregroundStyle(.secondary)
            Text("Retrying automatically… (Menu to change the server address)")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(40)
        .background(.black.opacity(0.85))
        .foregroundStyle(.white)
        .multilineTextAlignment(.center)
    }
}

/// One slide: an image in a shrink-wrapped white frame (matching the web
/// slideshow's `.slide-photo-frame` styling — see client/src/styles/
/// global.css) or a fullscreen autoplaying video.
private struct SlideView: View {
    let item: MediaItem
    let fileURL: URL?
    let isHighlighted: Bool
    let onVideoFinished: () -> Void

    var body: some View {
        ZStack {
            if item.isVideo, let fileURL {
                VideoSlide(url: fileURL, onFinished: onVideoFinished)
            } else if let fileURL {
                PhotoSlide(item: item, url: fileURL)
            }

            if isHighlighted {
                VStack {
                    Text("🆕 New Upload")
                        .font(.headline)
                        .padding(.horizontal, 20)
                        .padding(.vertical, 10)
                        .background(.black.opacity(0.7))
                        .foregroundStyle(.white)
                        .clipShape(Capsule())
                        .padding(.top, 40)
                    Spacer()
                }
            }
        }
    }
}

private struct PhotoSlide: View {
    let item: MediaItem
    let url: URL

    var body: some View {
        AsyncImage(url: url) { phase in
            if let image = phase.image {
                image
                    .resizable()
                    .aspectRatio(contentMode: .fit)
            }
        }
        // Shrink-wrapped white "photo frame" matching the web slideshow's
        // `.slide-photo-frame` — padding + light background hugging the
        // image's own rendered size, not the full screen.
        .padding(20)
        .background(Color(red: 0.96, green: 0.96, blue: 0.94))
        // `.overlay` (not a sibling in a shared ZStack) so the tags are
        // guaranteed to size/position against THIS view's actual reported
        // box — a ZStack sibling let the tags' Spacer expand to the full
        // screen width instead of the frame's width, pinning the uploader
        // tag to the screen edge rather than the frame's edge (caught via a
        // real screenshot; the same class of bug the web version hit and
        // fixed earlier by nesting tags inside the frame wrapper).
        .overlay(alignment: .bottom) {
            tags.padding(.bottom, 12).padding(.horizontal, 12)
        }
        .shadow(color: .black.opacity(0.5), radius: 24, y: 8)
        .padding(48)
    }

    @ViewBuilder
    private var tags: some View {
        HStack {
            if let uploader = item.uploader, !uploader.isEmpty {
                tagLabel(uploader)
            }
            Spacer()
            if let photoTakenAt = item.photoTakenAt {
                tagLabel(Self.dateFormatter.string(from: Date(timeIntervalSince1970: photoTakenAt / 1000)))
            }
        }
    }

    private func tagLabel(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(.black.opacity(0.6))
            .foregroundStyle(.white)
            .clipShape(Capsule())
    }

    private static let dateFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        return formatter
    }()
}

private struct VideoSlide: View {
    let url: URL
    let onFinished: () -> Void

    @State private var player: AVPlayer?
    @State private var endObserver: NSObjectProtocol?

    var body: some View {
        Group {
            if let player {
                VideoPlayer(player: player)
                    .onAppear { player.play() }
            }
        }
        .onAppear {
            let newPlayer = AVPlayer(url: url)
            player = newPlayer
            endObserver = NotificationCenter.default.addObserver(
                forName: .AVPlayerItemDidPlayToEndTime,
                object: newPlayer.currentItem,
                queue: .main
            ) { _ in
                onFinished()
            }
        }
        .onDisappear {
            if let endObserver {
                NotificationCenter.default.removeObserver(endObserver)
            }
            player?.pause()
            player = nil
        }
    }
}
