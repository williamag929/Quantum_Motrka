# voice\stt-win.ps1
# Local continuous speech-to-text using Windows built-in System.Speech (.NET Framework).
# Uses a synchronous Recognize() loop — avoids PowerShell's .NET event binding limitation
# (+=  is C# syntax; Register-ObjectEvent runs in a separate runspace that can't reliably
#  write to the parent process stdout pipe).
# No network calls. Audio never leaves the machine.

try {
    Add-Type -AssemblyName System.Speech

    $engine = New-Object System.Speech.Recognition.SpeechRecognitionEngine
    $engine.SetInputToDefaultAudioDevice()

    # DictationGrammar: free-form speech, no vocabulary restrictions
    $grammar = New-Object System.Speech.Recognition.DictationGrammar
    $engine.LoadGrammar($grammar)

    # 10-second window per utterance — loops back immediately if silence
    $timeout = New-TimeSpan -Seconds 10

    while ($true) {
        try {
            $result = $engine.Recognize($timeout)
            if ($result -and $result.Text) {
                [Console]::WriteLine($result.Text.Trim())
                [Console]::Out.Flush()
            }
        } catch {
            # Transient audio device hiccup — pause briefly and retry
            Start-Sleep -Milliseconds 300
        }
    }

} catch {
    [Console]::Error.WriteLine("STT init failed: $_")
    exit 1
}
