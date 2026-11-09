import AVFoundation
import Observation

/// The microphone while Send is held: 16 kHz mono WAV, the format the computer's speech model reads,
/// with how loud it is for the waveform. A recording stops itself at the length the computer accepts.
@MainActor
@Observable
final class VoiceRecorder {
    static let maximumSeconds: TimeInterval = 120
    private static let bars = 36

    /// The latest loudness readings, oldest first, each from 0 to 1.
    private(set) var levels: [Float] = Array(repeating: 0, count: VoiceRecorder.bars)
    private(set) var recording = false
    /// When the microphone started hearing, for the elapsed time beside the wave.
    private(set) var startedAt: Date?

    @ObservationIgnored private var recorder: AVAudioRecorder?
    @ObservationIgnored private var meter: Task<Void, Never>?

    enum Failure: LocalizedError {
        case denied, unavailable
        var errorDescription: String? {
            switch self {
            case .denied: "Allow the microphone for AI Coding Tool in Settings to hold and talk."
            case .unavailable: "The microphone could not start."
            }
        }
    }

    func start() async throws {
        guard await AVAudioApplication.requestRecordPermission() else { throw Failure.denied }
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.playAndRecord, mode: .spokenAudio, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try session.setActive(true)
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("hold-\(UUID().uuidString).wav")
        let settings: [String: Any] = [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
        ]
        let created = try AVAudioRecorder(url: url, settings: settings)
        created.isMeteringEnabled = true
        guard created.record(forDuration: Self.maximumSeconds) else { throw Failure.unavailable }
        recorder = created
        recording = true
        startedAt = Date()
        levels = Array(repeating: 0, count: Self.bars)
        meter = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(50))
                self?.sample()
            }
        }
    }

    private func sample() {
        guard let recorder, recorder.isRecording else { return }
        recorder.updateMeters()
        let level = max(0, min(1, (recorder.averagePower(forChannel: 0) + 55) / 50))
        levels = Array(levels.dropFirst()) + [level]
    }

    /// The recording so far, as WAV bytes, and the microphone let go.
    func stop() -> Data? {
        guard let recorder else { return nil }
        let url = recorder.url
        finish()
        defer { try? FileManager.default.removeItem(at: url) }
        return try? Data(contentsOf: url)
    }

    func cancel() {
        guard let recorder else { return }
        let url = recorder.url
        finish()
        try? FileManager.default.removeItem(at: url)
    }

    private func finish() {
        meter?.cancel()
        meter = nil
        recorder?.stop()
        recorder = nil
        recording = false
        startedAt = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
