// Records the microphone and transcribes speech with Parakeet, reading the model FluidAudio keeps in
// ~/Library/Application Support/FluidAudio/Models, so a model another app downloaded is reused.
//
// One JSON object per line on stdin and stdout.
// In:  {"op":"status"} {"op":"download"} {"op":"start","id"} {"op":"stop","id"} {"op":"cancel","id"}
//      {"op":"transcribe","id","path"}
// Out: {"type":"model","state":"ready"|"missing"|"downloading"|"failed","message"?}
//      {"type":"started","id"} {"type":"level","id","value"} {"type":"text","id","text"}
//      {"type":"cancelled","id"} {"type":"error","id"?,"message"}
import AVFoundation
import FluidAudio
import Foundation
import os

private let output = FileHandle.standardOutput
private let outputLock = NSLock()

private func emit(_ message: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
    outputLock.lock()
    defer { outputLock.unlock() }
    output.write(data)
    output.write(Data([0x0A]))
}

private func fail(_ id: String?, _ message: String) {
    var payload: [String: Any] = ["type": "error", "message": message]
    if let id { payload["id"] = id }
    emit(payload)
}

/// The microphone, mixed to mono at its own rate. Levels go out as they arrive; samples are kept for the transcript.
private final class Recorder: @unchecked Sendable {
    /// Five minutes at 48 kHz; anything past it is dropped.
    private static let maximumSamples = 48_000 * 300
    private static let levelInterval: TimeInterval = 0.05

    private let engine = AVAudioEngine()
    private let lock = NSLock()
    private var samples: [Float] = []
    private var lastLevel = Date.distantPast
    private(set) var sampleRate: Double = 16_000

    func start(id: String) throws {
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw DictationError.message("No microphone is available.")
        }
        sampleRate = format.sampleRate
        samples.reserveCapacity(Int(format.sampleRate) * 30)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.append(buffer, id: id)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            throw DictationError.message("The microphone could not start: \(error.localizedDescription)")
        }
    }

    private func append(_ buffer: AVAudioPCMBuffer, id: String) {
        guard let channels = buffer.floatChannelData else { return }
        let frames = Int(buffer.frameLength)
        let channelCount = Int(buffer.format.channelCount)
        var mono = [Float](repeating: 0, count: frames)
        var energy: Float = 0
        for frame in 0..<frames {
            var sum: Float = 0
            for channel in 0..<channelCount { sum += channels[channel][frame] }
            let value = sum / Float(channelCount)
            mono[frame] = value
            energy += value * value
        }
        lock.lock()
        let room = Self.maximumSamples - samples.count
        if room > 0 { samples.append(contentsOf: mono.prefix(room)) }
        let now = Date()
        let due = now.timeIntervalSince(lastLevel) >= Self.levelInterval
        if due { lastLevel = now }
        lock.unlock()
        guard due, frames > 0 else { return }
        let rms = (energy / Float(frames)).squareRoot()
        let level = max(0, min(1, (20 * log10(max(rms, 1e-6)) + 55) / 50))
        emit(["type": "level", "id": id, "value": (Double(level) * 100).rounded() / 100])
    }

    func stop() -> [Float] {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        lock.lock()
        defer { lock.unlock() }
        let taken = samples
        samples = []
        return taken
    }
}

private enum DictationError: LocalizedError {
    case message(String)
    var errorDescription: String? {
        switch self { case .message(let text): text }
    }
}

private actor Dictation {
    private static let version: AsrModelVersion = .v2
    private static let minimumSamples = 16_000

    private var manager: AsrManager?
    private var loading: Task<AsrManager, Error>?
    private var recorder: Recorder?
    private var recordingId: String?

    /// FluidAudio's shared folder, unless `--models <folder>` names another.
    private static let directory: URL = {
        let arguments = CommandLine.arguments
        if let at = arguments.firstIndex(of: "--models"), at + 1 < arguments.count {
            return URL(fileURLWithPath: arguments[at + 1], isDirectory: true)
        }
        return AsrModels.defaultCacheDirectory(for: version)
    }()

    private var modelExists: Bool {
        AsrModels.modelsExist(at: Self.directory, version: Self.version)
    }

    func status() {
        guard modelExists else { return emit(["type": "model", "state": "missing"]) }
        emit(["type": "model", "state": "ready"])
        _ = try? loadManager()
    }

    /// Reports whole percents while files arrive, then no percent while the model is compiled for this Mac.
    func download() async {
        emit(["type": "model", "state": "downloading", "progress": 0])
        let reported = OSAllocatedUnfairLock(initialState: -1)
        do {
            let models = try await AsrModels.downloadAndLoad(to: Self.directory, version: Self.version) { update in
                let percent: Int
                switch update.phase {
                case .listing: percent = 0
                case .downloading(_, let total) where total > 0: percent = Int(min(max(update.fractionCompleted * 2, 0), 1) * 100)
                default: percent = -2
                }
                let changed = reported.withLock { last in
                    guard last != percent else { return false }
                    last = percent
                    return true
                }
                guard changed else { return }
                if percent < 0 { emit(["type": "model", "state": "downloading"]) }
                else { emit(["type": "model", "state": "downloading", "progress": Double(percent) / 100]) }
            }
            let created = AsrManager(config: .default)
            try await created.initialize(models: models)
            manager = created
            emit(["type": "model", "state": "ready"])
        } catch {
            emit(["type": "model", "state": "failed", "message": error.localizedDescription])
        }
    }

    /// Starts loading once; recording goes ahead while the model compiles.
    private func loadManager() throws -> Task<AsrManager, Error> {
        if let loading { return loading }
        guard modelExists else { throw DictationError.message("The speech model is not downloaded.") }
        let task = Task<AsrManager, Error> {
            let models = try await AsrModels.load(from: Self.directory, version: Self.version)
            let created = AsrManager(config: .default)
            try await created.initialize(models: models)
            return created
        }
        loading = task
        return task
    }

    private func readyManager() async throws -> AsrManager {
        if let manager { return manager }
        let task = try loadManager()
        do {
            let loaded = try await task.value
            manager = loaded
            return loaded
        } catch {
            loading = nil
            throw error
        }
    }

    func start(id: String) {
        if recorder != nil { return fail(id, "Dictation is already recording.") }
        guard modelExists else { return fail(id, "The speech model is not downloaded.") }
        _ = try? loadManager()
        let created = Recorder()
        do {
            try created.start(id: id)
        } catch {
            return fail(id, error.localizedDescription)
        }
        recorder = created
        recordingId = id
        emit(["type": "started", "id": id])
    }

    func stop(id: String) async {
        guard let recorder, recordingId == id else { return fail(id, "Nothing is recording.") }
        self.recorder = nil
        recordingId = nil
        let samples = recorder.stop()
        do {
            let resampled = try AudioConverter(sampleRate: 16_000).resample(samples, from: recorder.sampleRate)
            emit(["type": "text", "id": id, "text": try await transcribe(resampled)])
        } catch {
            fail(id, error.localizedDescription)
        }
    }

    func cancel(id: String) {
        if let recorder, recordingId == id {
            _ = recorder.stop()
            self.recorder = nil
            recordingId = nil
        }
        emit(["type": "cancelled", "id": id])
    }

    func transcribe(id: String, path: String) async {
        do {
            let samples = try AudioConverter(sampleRate: 16_000).resampleAudioFile(URL(fileURLWithPath: path))
            emit(["type": "text", "id": id, "text": try await transcribe(samples)])
        } catch {
            fail(id, error.localizedDescription)
        }
    }

    private func transcribe(_ samples: [Float]) async throws -> String {
        guard samples.count >= Self.minimumSamples / 4 else { return "" }
        let padded = samples + [Float](repeating: 0, count: max(0, Self.minimumSamples - samples.count))
        let manager = try await readyManager()
        return try await manager.transcribe(padded, source: .microphone).text
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

private let dictation = Dictation()

private func handle(_ line: String) async {
    guard let data = line.data(using: .utf8),
        let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let op = message["op"] as? String
    else { return fail(nil, "Unreadable request.") }
    let id = message["id"] as? String
    switch (op, id) {
    case ("status", _): await dictation.status()
    case ("download", _): Task { await dictation.download() }
    case ("start", let id?): await dictation.start(id: id)
    case ("stop", let id?): await dictation.stop(id: id)
    case ("cancel", let id?): await dictation.cancel(id: id)
    case ("transcribe", let id?):
        guard let path = message["path"] as? String else { return fail(id, "No file to transcribe.") }
        await dictation.transcribe(id: id, path: path)
    default: fail(id, "Unknown request \(op).")
    }
}

/// Requests run one at a time, in the order they arrive.
private let (lines, linesIn) = AsyncStream.makeStream(of: String.self)

Thread.detachNewThread {
    while let line = readLine() { linesIn.yield(line) }
    linesIn.finish()
}

Task {
    for await line in lines { await handle(line) }
    exit(0)
}

dispatchMain()
