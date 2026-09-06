import SwiftUI

/// Root view: shows Settings until a server address is configured, then the
/// slideshow — with the Siri Remote's Menu button (wired up inside
/// SlideshowView) able to bring Settings back if the address ever needs to
/// change, e.g. after moving to a different event/network.
struct ContentView: View {
    @StateObject private var serverStore = ServerStore()
    @State private var showingSettings = false

    var body: some View {
        if showingSettings || !serverStore.hasAddress || serverStore.baseURL == nil {
            SettingsView(serverStore: serverStore) {
                showingSettings = false
            }
        } else if let url = serverStore.baseURL {
            SlideshowView(baseURL: url) {
                showingSettings = true
            }
        }
    }
}

#Preview {
    ContentView()
}
