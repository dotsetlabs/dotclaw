/**
 * Discord message formatting.
 *
 * Discord natively supports Markdown, so no conversion is needed.
 * This module handles chunking long messages while preserving code fences,
 * and adds [1/N] markers for multi-part messages.
 */

type Segment = {
  type: 'text' | 'code';
  lang: string;
  content: string;
};

function splitByCodeFences(text: string): Segment[] {
  const segments: Segment[] = [];
  const fenceRegex = /```([a-zA-Z0-9_-]*)?\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', lang: '', content: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'code', lang: match[1] ?? '', content: match[2] ?? '' });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', lang: '', content: text.slice(lastIndex) });
  }

  return segments;
}

function splitTextPreservingNewlines(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const lines = text.split(/(\n)/);
  const chunks: string[] = [];
  let current = '';

  const pushCurrent = () => {
    if (!current) return;
    chunks.push(current);
    current = '';
  };

  for (const line of lines) {
    if (!line) continue;
    if (current.length + line.length <= maxLength) {
      current += line;
      continue;
    }

    pushCurrent();

    if (line.length > maxLength) {
      // Hard-split very long lines
      for (let i = 0; i < line.length; i += maxLength) {
        chunks.push(line.slice(i, i + maxLength));
      }
    } else {
      current = line;
    }
  }

  pushCurrent();
  return chunks;
}

function splitCodeBlock(lang: string, code: string, maxLength: number): string[] {
  const openFence = lang ? `\`\`\`${lang}\n` : '```\n';
  const closeFence = '\n```';
  const overhead = openFence.length + closeFence.length;

  if (code.length + overhead <= maxLength) {
    return [`${openFence}${code}${closeFence}`];
  }

  // Split code by lines, wrapping each chunk in fences
  const lines = code.split(/(\n)/);
  const chunks: string[] = [];
  let current = '';

  const pushCurrent = () => {
    if (!current) return;
    chunks.push(`${openFence}${current}${closeFence}`);
    current = '';
  };

  for (const line of lines) {
    if (!line) continue;
    if (current.length + line.length + overhead <= maxLength) {
      current += line;
      continue;
    }

    pushCurrent();

    if (line.length + overhead > maxLength) {
      // Hard-split very long lines within code fences
      const innerMax = maxLength - overhead;
      for (let i = 0; i < line.length; i += innerMax) {
        chunks.push(`${openFence}${line.slice(i, i + innerMax)}${closeFence}`);
      }
    } else {
      current = line;
    }
  }

  pushCurrent();
  return chunks;
}

function packPieces(pieces: string[], maxLength: number): string[] {
  const chunks: string[] = [];
  let current = '';

  for (const piece of pieces) {
    if (!piece) continue;
    if (!current) {
      current = piece;
      continue;
    }
    if (current.length + piece.length <= maxLength) {
      current += piece;
      continue;
    }
    chunks.push(current);
    current = piece;
  }

  if (current) chunks.push(current);
  return chunks;
}

/**
 * Format and chunk a message for Discord.
 *
 * Splits long messages at code fence boundaries and newlines,
 * respecting Discord's character limit. Multi-part messages
 * get [1/N] markers.
 */
export function formatDiscordMessage(text: string, maxLength: number): string[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const segments = splitByCodeFences(normalized);
  const pieces: string[] = [];
  // Reserve margin for chunk markers (e.g. "[1/10]\n" + "\n*[1/10] continued...*" ≈ 40 chars)
  const textMaxLength = Math.max(500, maxLength - 50);

  for (const segment of segments) {
    if (segment.type === 'code') {
      pieces.push(...splitCodeBlock(segment.lang, segment.content, textMaxLength));
      continue;
    }

    pieces.push(...splitTextPreservingNewlines(segment.content, textMaxLength));
  }

  const packed = packPieces(pieces, maxLength);

  // Add chunk markers for multi-part responses
  if (packed.length > 1) {
    for (let i = 0; i < packed.length; i++) {
      const marker = `[${i + 1}/${packed.length}]`;
      if (i > 0) {
        packed[i] = `${marker}\n${packed[i]}`;
      }
      if (i < packed.length - 1) {
        packed[i] = `${packed[i]}\n*${marker} continued...*`;
      }
    }
  }

  return packed;
}
