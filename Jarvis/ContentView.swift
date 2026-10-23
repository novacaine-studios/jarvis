import SwiftUI

struct ContentView: View {
    @EnvironmentObject var engine: JarvisEngine
    @State private var showSettings = false

    var body: some View {
        ZStack {
            CameraPreview(session: engine.camera.session)
                .ignoresSafeArea()

            VStack(spacing: 12) {
                HStack {
                    Label(engine.state.label, systemImage: engine.state.icon)
                        .padding(8)
                        .background(.ultraThinMaterial, in: Capsule())
                    Spacer()
                    Button { showSettings = true } label: {
                        Image(systemName: "gearshape").padding(8)
                    }
                    .background(.ultraThinMaterial, in: Circle())
                }

                Spacer()

                if !engine.heardText.isEmpty {
                    Text("“\(engine.heardText)”")
                        .font(.callout)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
                }
                if !engine.replyText.isEmpty {
                    Text(engine.replyText)
                        .font(.body)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding()
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                }

                Button(engine.isRunning ? "Stop Jarvis" : "Start Jarvis") {
                    engine.isRunning ? engine.stop() : engine.start()
                }
                .buttonStyle(.borderedProminent)
            }
            .padding()
        }
        .sheet(isPresented: $showSettings) {
            SettingsView()
        }
        .onAppear {
            // No buttons needed: Jarvis starts listening as soon as the app opens.
            if KeychainStore.apiKey == nil {
                showSettings = true
            } else {
                engine.start()
            }
        }
        .onChange(of: showSettings) { _, isShowing in
            if !isShowing, KeychainStore.apiKey != nil { engine.start() }
        }
    }
}

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var key = KeychainStore.apiKey ?? ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    SecureField("sk-ant-…", text: $key)
                } header: {
                    Text("Anthropic API key")
                } footer: {
                    Text("Stored in the iOS Keychain on this phone. Fine for a personal prototype; a shipped app should call a server instead.")
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                Button("Save") {
                    KeychainStore.apiKey = key.trimmingCharacters(in: .whitespacesAndNewlines)
                    dismiss()
                }
            }
        }
    }
}
