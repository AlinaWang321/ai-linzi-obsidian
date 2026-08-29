export const ARTICLE_VIDEO_LOCAL_AUDIO_MIN_BYTES = 8 * 1024

export const WINDOWS_SPEECH_TEXT_ENV = 'AI_LINZI_LOCAL_VOICE_TEXT'
export const WINDOWS_SPEECH_OUTPUT_ENV = 'AI_LINZI_LOCAL_VOICE_OUTPUT'

export interface ArticleVideoProcessInvocation {
  command: string
  args: string[]
  environment?: Record<string, string>
}

export function windowsSpeechInvocation(
  textFile: string,
  outputFile: string,
): ArticleVideoProcessInvocation {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [Console]::OutputEncoding',
    `$textPath = [Environment]::GetEnvironmentVariable('${WINDOWS_SPEECH_TEXT_ENV}')`,
    `$audioPath = [Environment]::GetEnvironmentVariable('${WINDOWS_SPEECH_OUTPUT_ENV}')`,
    "if ([string]::IsNullOrWhiteSpace($textPath) -or [string]::IsNullOrWhiteSpace($audioPath)) { throw 'AI霖子本机配音缺少临时文件路径。' }",
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    'try {',
    "  $v = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and $_.VoiceInfo.Culture.Name -like 'zh-*' } | Select-Object -First 1",
    "  if (-not $v) { throw '没有找到可用的中文系统语音。请在 Windows 设置中安装中文语音包，或改用 Fish Audio。' }",
    '  $s.SelectVoice($v.VoiceInfo.Name)',
    '  $text = [IO.File]::ReadAllText($textPath, [Text.Encoding]::UTF8)',
    "  if ([string]::IsNullOrWhiteSpace($text)) { throw '本机配音文本为空。' }",
    '  $s.SetOutputToWaveFile($audioPath)',
    '  $s.Speak($text)',
    '} finally {',
    '  $s.Dispose()',
    '}',
  ].join('\n')
  return {
    command: 'powershell.exe',
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    environment: {
      [WINDOWS_SPEECH_TEXT_ENV]: textFile,
      [WINDOWS_SPEECH_OUTPUT_ENV]: outputFile,
    },
  }
}

export function macSayAttempts(
  voice: string | undefined,
  textFile: string,
  outputFile: string,
): string[][] {
  return [
    [...(voice ? ['-v', voice] : []), '--file-format=AIFF', '-o', outputFile, '-f', textFile],
    [...(voice ? ['-v', voice] : []), '-o', outputFile, '-f', textFile],
    ['--file-format=AIFF', '-o', outputFile, '-f', textFile],
  ]
}

export function macSpeechFallbackInvocation(
  textFile: string,
  outputFile: string,
): ArticleVideoProcessInvocation {
  const script = [
    "ObjC.import('AppKit')",
    'function run(argv) {',
    '  const readError = Ref()',
    '  const source = $.NSString.stringWithContentsOfFileEncodingError(argv[0], $.NSUTF8StringEncoding, readError)',
    "  if (!source) throw new Error('macOS system voice could not read the UTF-8 text file')",
    '  const synthesizer = $.NSSpeechSynthesizer.alloc.init',
    '  const target = $.NSURL.fileURLWithPath(argv[1])',
    '  const started = synthesizer.startSpeakingStringToURL(ObjC.unwrap(source), target)',
    "  if (!started) throw new Error('macOS system voice failed to start')",
    '  while (synthesizer.isSpeaking) {',
    '    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.1))',
    '  }',
    '  return true',
    '}',
  ].join('; ')
  return {
    command: '/usr/bin/osascript',
    args: ['-l', 'JavaScript', '-e', script, textFile, outputFile],
  }
}

export function hasValidLocalSpeechSize(size: number): boolean {
  return Number.isFinite(size) && size >= ARTICLE_VIDEO_LOCAL_AUDIO_MIN_BYTES
}
