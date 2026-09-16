$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$taskRoot = Split-Path -Parent $PSScriptRoot
$catalog = Get-Content -LiteralPath (Join-Path $taskRoot 'modules/listen-read/content/stories.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$audioParts = Join-Path $taskRoot 'tools/quiz-audio-parts'
New-Item -ItemType Directory -Force -Path $audioParts | Out-Null
$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
$speech.SelectVoice('Microsoft Zira Desktop')
$speech.Rate = -1
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(11025, [System.Speech.AudioFormat.AudioBitsPerSample]::Eight, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($book in $catalog.books) {
  foreach ($chapter in $book.chapters) {
    for ($questionIndex = 0; $questionIndex -lt $chapter.quiz.Count; $questionIndex++) {
      for ($optionIndex = 0; $optionIndex -lt $chapter.quiz[$questionIndex].options.Count; $optionIndex++) {
        $target = Join-Path $audioParts ($chapter.id + '-' + $questionIndex + '-' + $optionIndex + '.wav')
        $speech.SetOutputToWaveFile($target, $format)
        $speech.Speak([string]$chapter.quiz[$questionIndex].options[$optionIndex])
        $speech.SetOutputToNull()
      }
    }
  }
}
$speech.Dispose()
Write-Output 'Generated 54 independent answer recordings.'
