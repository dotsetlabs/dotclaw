import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const SCREENSHOTS_DIR = '/workspace/group/screenshots';
const BROWSER_CMD = 'agent-browser';

export interface BrowserResult {
  success: boolean;
  title?: string;
  url?: string;
  elements?: unknown[];
  text?: string;
  html?: string;
  result?: unknown;
  path?: string;
  width?: number;
  height?: number;
  error?: string;
}

export class BrowserSession {
  private timeoutMs: number;
  private screenshotQuality: number;

  constructor(options?: { timeoutMs?: number; screenshotQuality?: number }) {
    this.timeoutMs = options?.timeoutMs ?? 30_000;
    this.screenshotQuality = options?.screenshotQuality ?? 80;
  }

  private async exec(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = spawn(BROWSER_CMD, args, {
        timeout: this.timeoutMs,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, BROWSER_JSON_OUTPUT: '1' }
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });
      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Browser command exited with code ${code}`));
        } else {
          resolve(stdout);
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`Browser command failed: ${err.message}`));
      });
    });
  }

  private parseOutput(raw: string): unknown {
    try {
      return JSON.parse(raw);
    } catch {
      return { text: raw.trim() };
    }
  }

  async navigate(url: string): Promise<BrowserResult> {
    try {
      const output = await this.exec(['navigate', url]);
      const parsed = this.parseOutput(output) as Record<string, unknown>;
      return {
        success: true,
        title: parsed.title as string | undefined,
        url: parsed.url as string | undefined
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async snapshot(interactive?: boolean): Promise<BrowserResult> {
    try {
      const args = ['snapshot'];
      if (interactive) args.push('--interactive');
      const output = await this.exec(args);
      const parsed = this.parseOutput(output) as Record<string, unknown>;
      return {
        success: true,
        elements: parsed.elements as unknown[] | undefined,
        text: parsed.text as string | undefined
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async click(ref: string): Promise<BrowserResult> {
    try {
      const output = await this.exec(['click', ref]);
      const parsed = this.parseOutput(output) as Record<string, unknown>;
      return {
        success: true,
        url: parsed.url as string | undefined
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async fill(ref: string, text: string): Promise<BrowserResult> {
    try {
      await this.exec(['fill', ref, text]);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async screenshot(fullPage?: boolean): Promise<BrowserResult> {
    try {
      fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
      const filename = `screenshot_${Date.now()}.png`;
      const filepath = path.join(SCREENSHOTS_DIR, filename);
      const args = ['screenshot', '--output', filepath, '--quality', String(this.screenshotQuality)];
      if (fullPage) args.push('--full-page');
      await this.exec(args);
      if (!fs.existsSync(filepath)) {
        return { success: false, error: 'Screenshot file not created' };
      }
      return {
        success: true,
        path: filepath
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async extract(selector?: string): Promise<BrowserResult> {
    try {
      const args = ['extract'];
      if (selector) args.push('--selector', selector);
      const output = await this.exec(args);
      const parsed = this.parseOutput(output) as Record<string, unknown>;
      return {
        success: true,
        text: parsed.text as string | undefined,
        html: parsed.html as string | undefined
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async evaluate(js: string): Promise<BrowserResult> {
    try {
      const output = await this.exec(['evaluate', js]);
      const parsed = this.parseOutput(output);
      return {
        success: true,
        result: parsed
      };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async close(): Promise<BrowserResult> {
    try {
      await this.exec(['close']);
      return { success: true };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
  }
}
