import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { loadRuntimeConfig } from './runtime-config.js';
import { logger } from './logger.js';

const runtime = loadRuntimeConfig();
const voiceConfig = runtime.host.voice;

const MAX_RETRIES = 2;
const TIMEOUT_MS = 30_000;

/**
 * Convert audio to mono 16kHz WAV using ffmpeg.
 * OpenRouter's input_audio requires WAV format — OGG/Opus from Telegram
 * is not reliably handled by providers.
 */
function convertToWav(inputPath: string): string {
  const wavPath = inputPath.replace(/\.[^.]+$/, '_transcribe.wav');
  execFileSync('ffmpeg', [
    '-y', '-i', inputPath,
    '-ac', '1',       // mono
    '-ar', '16000',   // 16kHz (standard for speech recognition)
    wavPath
  ], { timeout: 15_000, stdio: 'pipe' });
  return wavPath;
}

export async function transcribeVoice(filePath: string): Promise<string | null> {
  if (!voiceConfig.transcription.enabled) return null;

  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    logger.warn({ filePath }, 'Voice file not found for transcription');
    return null;
  }

  const stat = fs.statSync(resolvedPath);
  if (stat.size === 0) {
    logger.warn({ filePath }, 'Voice file is empty');
    return null;
  }

  // Convert to WAV first (required for reliable OpenRouter audio input)
  let wavPath: string | null = null;
  try {
    wavPath = convertToWav(resolvedPath);
  } catch (err) {
    logger.error({ error: err instanceof Error ? err.message : String(err) }, 'ffmpeg conversion failed — is ffmpeg installed?');
    return null;
  }

  try {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await callTranscriptionApi(wavPath);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_RETRIES) {
          logger.warn({ attempt, error: message }, 'Transcription failed, retrying');
          await new Promise(r => setTimeout(r, 1000 * Math.pow(2, attempt)));
        } else {
          logger.error({ error: message, filePath }, 'Transcription failed after retries');
          return null;
        }
      }
    }
    return null;
  } finally {
    // Clean up temp WAV file
    try { fs.unlinkSync(wavPath); } catch { /* ignore */ }
  }
}

async function callTranscriptionApi(wavPath: string): Promise<string> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set');
  }

  const fileBuffer = fs.readFileSync(wavPath);
  const base64Audio = fileBuffer.toString('base64');

  const languageHint = voiceConfig.transcription.language
    ? ` The audio is in ${voiceConfig.transcription.language}.`
    : '';

  // Plain chat completions with input_audio — no modalities/stream needed.
  // Matches the proven OpenClaw openrouter-transcribe approach.
  const payload = {
    model: voiceConfig.transcription.model,
    messages: [
      {
        role: 'user' as const,
        content: [
          {
            type: 'text',
            text: `Transcribe this audio exactly. Output only the transcription text, nothing else.${languageHint}`
          },
          {
            type: 'input_audio',
            input_audio: { data: base64Audio, format: 'wav' }
          }
        ]
      }
    ],
  };

  const response = await fetch(`${voiceConfig.transcription.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://dotsetlabs.com',
      'X-Title': 'DotClaw',
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Transcription API error ${response.status}: ${body.slice(0, 500)}`);
  }

  const result = JSON.parse(body) as {
    choices?: Array<{ message?: { content?: string } }>;
  };

  const text = result.choices?.[0]?.message?.content;
  if (!text || typeof text !== 'string') {
    throw new Error(`Transcription response missing text content: ${body.slice(0, 300)}`);
  }

  logger.info({ model: voiceConfig.transcription.model, transcriptLength: text.length, preview: text.slice(0, 200) }, 'Transcription result');

  return text.trim();
}

/**
 * Host-side TTS: convert text to an OGG Opus voice file using Edge TTS.
 * Edge TTS outputs MP3, then ffmpeg converts to OGG Opus for Telegram.
 * Returns the path to the generated .ogg file, or null on failure.
 */
export async function synthesizeSpeechHost(text: string, outputDir: string): Promise<string | null> {
  if (!voiceConfig.tts.enabled) return null;
  if (!text || !text.trim()) return null;

  let mp3Path: string | null = null;
  try {
    const { EdgeTTS } = await import('node-edge-tts');
    const tts = new EdgeTTS({
      voice: voiceConfig.tts.defaultVoice,
      lang: 'en-US',
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
      timeout: 15_000,
    });

    fs.mkdirSync(outputDir, { recursive: true });
    const ts = Date.now();
    mp3Path = path.join(outputDir, `tts_reply_${ts}.mp3`);
    const oggPath = path.join(outputDir, `tts_reply_${ts}.ogg`);

    await tts.ttsPromise(text.slice(0, 4096), mp3Path);

    // Convert MP3 → OGG Opus for Telegram voice notes
    execFileSync('ffmpeg', [
      '-y', '-i', mp3Path,
      '-c:a', 'libopus', '-b:a', '48k',
      oggPath
    ], { timeout: 15_000, stdio: 'pipe' });

    const stat = fs.statSync(oggPath);
    logger.info({ outputPath: oggPath, bytes: stat.size, voice: voiceConfig.tts.defaultVoice }, 'TTS voice generated');
    return oggPath;
  } catch (err) {
    logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'TTS synthesis failed');
    return null;
  } finally {
    // Clean up temp MP3
    if (mp3Path) try { fs.unlinkSync(mp3Path); } catch { /* ignore */ }
  }
}
