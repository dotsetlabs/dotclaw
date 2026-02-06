import fs from 'fs';
import path from 'path';
import { loadAgentConfig } from './agent-config.js';

const WORKSPACE_GROUP = '/workspace/group';
const OUTPUT_DIR = path.join(WORKSPACE_GROUP, 'voice_output');

export interface TtsOptions {
  voice?: string;
  language?: string;
  speed?: number;
}

export async function synthesizeSpeech(text: string, options?: TtsOptions): Promise<string> {
  const config = loadAgentConfig();
  const ttsConfig = config.agent.tts;

  if (!ttsConfig.enabled) {
    throw new Error('TTS is disabled in agent configuration');
  }

  if (!text || !text.trim()) {
    throw new Error('Text is required for TTS');
  }

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const voice = options?.voice || ttsConfig.defaultVoice;
  const lang = options?.language || 'en-US';
  const rate = options?.speed && options.speed !== 1.0
    ? `${options.speed > 1 ? '+' : ''}${Math.round((options.speed - 1) * 100)}%`
    : 'default';

  const { EdgeTTS } = await import('node-edge-tts');
  const tts = new EdgeTTS({
    voice,
    lang,
    outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
    rate,
    timeout: 15_000,
  });

  const ts = Date.now();
  const mp3Path = path.join(OUTPUT_DIR, `tts_${ts}.mp3`);
  const oggPath = path.join(OUTPUT_DIR, `tts_${ts}.ogg`);

  await tts.ttsPromise(text.slice(0, 4096), mp3Path);

  // Convert MP3 → OGG Opus for Telegram voice notes
  const { execFileSync } = await import('child_process');
  execFileSync('ffmpeg', [
    '-y', '-i', mp3Path,
    '-c:a', 'libopus', '-b:a', '48k',
    oggPath
  ], { timeout: 15_000, stdio: 'pipe' });

  // Clean up temp MP3
  try { fs.unlinkSync(mp3Path); } catch { /* ignore */ }

  return oggPath;
}
