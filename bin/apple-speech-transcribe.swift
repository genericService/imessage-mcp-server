#!/usr/bin/env swift
import Foundation
import Speech

guard CommandLine.arguments.count >= 2 else {
    fputs("Usage: apple-speech-transcribe <audio-file-path> [locale-hints]\n", stderr)
    exit(1)
}

let audioPath = CommandLine.arguments[1]
let audioUrl = URL(fileURLWithPath: audioPath)
guard FileManager.default.fileExists(atPath: audioPath) else {
    fputs("Audio file not found: \(audioPath)\n", stderr)
    exit(1)
}

let localeHintsRaw = CommandLine.arguments.count >= 3 ? CommandLine.arguments[2] : "es-MX,es,en-US,en"
let localeHints = localeHintsRaw.components(separatedBy: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }

// Check authorization status
let authStatus = SFSpeechRecognizer.authorizationStatus()
if authStatus == .denied || authStatus == .restricted {
    fputs("Apple Speech Recognition permission is not authorized. Grant access in System Settings > Privacy & Security > Speech Recognition.\n", stderr)
    exit(2)
}

if authStatus == .notDetermined {
    let sema = DispatchSemaphore(value: 0)
    var authorized = false
    SFSpeechRecognizer.requestAuthorization { status in
        authorized = (status == .authorized)
        sema.signal()
    }
    _ = sema.wait(timeout: .now() + 5.0)
    if !authorized {
        fputs("Apple Speech Recognition authorization was declined or timed out.\n", stderr)
        exit(2)
    }
}

// Select recognizer supporting on-device recognition
var selectedRecognizer: SFSpeechRecognizer? = nil
var selectedLocale: String = "es"

for hint in localeHints {
    let loc = Locale(identifier: hint)
    if let rec = SFSpeechRecognizer(locale: loc), rec.isAvailable {
        selectedRecognizer = rec
        selectedLocale = hint
        break
    }
}

if selectedRecognizer == nil {
    // Fall back to current system locale
    if let rec = SFSpeechRecognizer() {
        selectedRecognizer = rec
        selectedLocale = rec.locale.identifier
    }
}

guard let recognizer = selectedRecognizer else {
    fputs("No available SpeechRecognizer for requested locales: \(localeHintsRaw)\n", stderr)
    exit(3)
}

let request = SFSpeechURLRecognitionRequest(url: audioUrl)
request.requiresOnDeviceRecognition = true
request.shouldReportPartialResults = false

let sema = DispatchSemaphore(value: 0)
var transcriptionText: String? = nil
var segments: [[String: Any]] = []
var recognitionError: Error? = nil

let task = recognizer.recognitionTask(with: request) { result, error in
    if let result = result {
        transcriptionText = result.bestTranscription.formattedString
        for seg in result.bestTranscription.segments {
            segments.append([
                "start": seg.timestamp,
                "end": seg.timestamp + seg.duration,
                "text": seg.substring
            ])
        }
    }
    if error != nil || (result != nil && result!.isFinal) {
        recognitionError = error
        sema.signal()
    }
}

let timeoutSeconds = 60.0
let waitResult = sema.wait(timeout: .now() + timeoutSeconds)
if waitResult == .timedOut {
    task.cancel()
    fputs("Speech recognition timed out after \(timeoutSeconds) seconds\n", stderr)
    exit(4)
}

if let err = recognitionError {
    fputs("Speech recognition error: \(err.localizedDescription)\n", stderr)
    exit(5)
}

guard let finalTxt = transcriptionText, !finalTxt.trimmingCharacters(in: .whitespaces).isEmpty else {
    fputs("No speech detected\n", stderr)
    exit(6)
}

let outputData: [String: Any] = [
    "transcription": finalTxt,
    "language": selectedLocale,
    "segments": segments
]

if let jsonData = try? JSONSerialization.data(withJSONObject: outputData, options: [.prettyPrinted]),
   let jsonString = String(data: jsonData, encoding: .utf8) {
    print(jsonString)
    exit(0)
} else {
    exit(1)
}
