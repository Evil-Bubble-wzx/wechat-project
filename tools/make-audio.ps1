$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
$taskRoot = Split-Path -Parent $PSScriptRoot
$catalog = Get-Content -LiteralPath (Join-Path $taskRoot 'modules/listen-read/content/stories.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$audioParts = Join-Path $taskRoot 'tools/audio-parts'
New-Item -ItemType Directory -Force -Path $audioParts | Out-Null
$speech = New-Object System.Speech.Synthesis.SpeechSynthesizer
$speech.SelectVoice('Microsoft Zira Desktop')
$speech.Rate = -1
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Eight, [System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($book in $catalog.books) {
  foreach ($chapter in $book.chapters) {
    for ($i = 0; $i -lt $chapter.sentences.Count; $i++) {
      $target = Join-Path $audioParts ($chapter.id + '-' + $i + '.wav')
      $speech.SetOutputToWaveFile($target, $format)
      $speech.Speak([string]$chapter.sentences[$i][0])
      $speech.SetOutputToNull()
    }
  }
}
$speech.Dispose()
Write-Output 'Generated 24 sentence recordings with the installed English voice.'
