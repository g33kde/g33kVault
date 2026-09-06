import SwiftUI

/// First-run (and "Menu button from the slideshow") screen — the one piece
/// of setup a self-hosted app can't avoid, since there's no fixed server to
/// point at. Kept to a single field on purpose: a Siri Remote's on-screen
/// keyboard is tedious enough to type on without asking for a scheme or a
/// path too (ServerStore fills both in).
struct SettingsView: View {
    @ObservedObject var serverStore: ServerStore
    let onConnect: () -> Void

    @State private var draftAddress: String = ""
    @FocusState private var fieldFocused: Bool

    var body: some View {
        VStack(spacing: 32) {
            VStack(spacing: 8) {
                Text("g33kVault")
                    .font(.system(size: 56, weight: .bold, design: .monospaced))
                Text("Enter your g33kVault server's address")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }

            VStack(spacing: 16) {
                // .roundedBorder is unavailable on tvOS (caught by a real
                // build attempt) — tvOS's default TextField style already
                // renders its own focus-driven chrome via the Siri Remote,
                // so no explicit style is needed here.
                TextField("192.168.1.42:3000", text: $draftAddress)
                    .font(.system(size: 28, design: .monospaced))
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 700)
                    .autocorrectionDisabled()
                    .focused($fieldFocused)

                Text("Same address you'd open on the host screen or /admin — no need to type \"http://\".")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 600)
            }

            Button("Connect") {
                serverStore.address = draftAddress
                onConnect()
            }
            .disabled(draftAddress.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            .buttonStyle(.borderedProminent)
        }
        .padding(60)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.black.ignoresSafeArea())
        .foregroundStyle(.white)
        .onAppear {
            draftAddress = serverStore.address
            fieldFocused = true
        }
    }
}
