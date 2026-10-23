import SwiftUI

@main
struct JarvisApp: App {
    @StateObject private var engine = JarvisEngine.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(engine)
        }
    }
}
