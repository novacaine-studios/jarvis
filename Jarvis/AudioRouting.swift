import AVFoundation

/// Audio setup. Jarvis never reads or changes the system volume setting; it only plays at whatever
/// level the phone is already at, through whatever output iOS has picked.
enum AudioRouting {
    static func configure() throws {
        let session = AVAudioSession.sharedInstance()
        // .playAndRecord lets us listen for "Jarvis" and talk back in the same session.
        // .allowBluetooth uses the AirPods microphone when they're connected, so Jarvis hears you
        //   with the phone in your pocket. While Jarvis is listening, AirPods run in their
        //   headset mode, so music through them sounds like a phone call.
        // .allowBluetoothA2DP is used for playback when AirPods aren't recording.
        // .defaultToSpeaker uses the loudspeaker (not the earpiece) when nothing is connected.
        // .mixWithOthers keeps your music or podcast playing.
        try session.setCategory(
            .playAndRecord,
            mode: .default,
            options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker, .mixWithOthers]
        )
        try session.setActive(true)
    }

    /// True when headphones are connected, or when the phone's volume isn't all the way down.
    /// When this is false the reply is only shown on screen.
    static var canSpeakAloud: Bool {
        let session = AVAudioSession.sharedInstance()
        let headphones: Set<AVAudioSession.Port> = [.bluetoothA2DP, .bluetoothHFP, .bluetoothLE, .headphones, .usbAudio]
        if session.currentRoute.outputs.contains(where: { headphones.contains($0.portType) }) {
            return true
        }
        return session.outputVolume > 0
    }
}
