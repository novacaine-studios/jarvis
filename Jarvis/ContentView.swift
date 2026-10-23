import SwiftUI

struct ContentView: View {
    @EnvironmentObject var engine: JarvisEngine

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
                }

                if !engine.brainStatus.isEmpty {
                    Text(engine.brainStatus)
                        .font(.footnote)
                        .padding(8)
                        .background(.ultraThinMaterial, in: Capsule())
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
        .onAppear {
            // No buttons needed: Jarvis starts listening as soon as the app opens.
            engine.start()
        }
    }
}
