type Segment = {
  type: 'text' | 'code';
  content: string;
};

const TEXT_LENGTH_MARGIN = 200;

export const TELEGRAM_PARSE_MODE = 'HTML' as const;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

function splitByCodeFences(text: string): Segment[] {
  const segments: Segment[] = [];
  const fenceRegex = /```([a-zA-Z0-9_-]+)?\n?([\s\S]*?)```/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = fenceRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    segments.push({ type: 'code', content: match[2] ?? '' });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    segments.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return segments;
}

function splitTextPreservingNewlines(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text];

  const tokens = text.split(/(\n)/);
  const chunks: string[] = [];
  let current = '';

  const pushCurrent = () => {
    if (!current) return;
    chunks.push(current);
    current = '';
  };

  for (const token of tokens) {
    if (!token) continue;
    if (current.length + token.length <= maxLength) {
      current += token;
      continue;
    }

    pushCurrent();

    if (token.length > maxLength) {
      const parts = splitLongString(token, maxLength);
      chunks.push(...parts.slice(0, -1));
      current = parts[parts.length - 1] ?? '';
    } else {
      current = token;
    }
  }

  pushCurrent();
  return chunks;
}

function splitLongString(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += maxLength) {
    chunks.push(text.slice(i, i + maxLength));
  }
  return chunks;
}

function normalizeHeadings(text: string): string {
  return text
    .split('\n')
    .map(line => {
      const match = line.match(/^#{1,6}\s+(.*)$/);
      if (!match) return line;
      return `**${match[1]}**`;
    })
    .join('\n');
}

function formatInlineMarkdownToHtml(text: string): string {
  const placeholders: Array<{ token: string; html: string }> = [];
  const insertToken = (html: string) => {
    const token = `\u0000${placeholders.length}\u0000`;
    placeholders.push({ token, html });
    return token;
  };

  let working = text;

  // Inline code
  working = working.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    return insertToken(`<code>${escapeHtml(code)}</code>`);
  });

  // Links
  working = working.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_match, label: string, url: string) => {
    return insertToken(`<a href="${escapeHtmlAttribute(url)}">${escapeHtml(label)}</a>`);
  });

  // Bold
  working = working.replace(/\*\*([^\n]+?)\*\*/g, (_match, bold: string) => {
    return insertToken(`<b>${escapeHtml(bold)}</b>`);
  });

  // Strikethrough
  working = working.replace(/~~([^\n]+?)~~/g, (_match, strike: string) => {
    return insertToken(`<s>${escapeHtml(strike)}</s>`);
  });

  // Italic (asterisks only, avoids underscore collisions with identifiers)
  working = working.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, (_match, italic: string) => {
    return insertToken(`<i>${escapeHtml(italic)}</i>`);
  });

  working = escapeHtml(working);

  for (const { token, html } of placeholders) {
    working = working.split(token).join(html);
  }

  return working;
}

function formatTextChunk(text: string): string {
  const normalized = normalizeHeadings(text);
  return formatInlineMarkdownToHtml(normalized);
}

function splitCodeBlock(code: string, maxLength: number): string[] {
  const openTag = '<pre><code>';
  const closeTag = '</code></pre>';
  const overhead = openTag.length + closeTag.length;
  const escaped = escapeHtml(code);

  if (escaped.length + overhead <= maxLength) {
    return [`${openTag}${escaped}${closeTag}`];
  }

  const tokens = escaped.split(/(\n)/);
  const chunks: string[] = [];
  let current = '';

  const pushCurrent = () => {
    if (!current) return;
    chunks.push(`${openTag}${current}${closeTag}`);
    current = '';
  };

  for (const token of tokens) {
    if (!token) continue;
    if (current.length + token.length + overhead <= maxLength) {
      current += token;
      continue;
    }

    pushCurrent();

    if (token.length + overhead > maxLength) {
      const parts = splitLongString(token, maxLength - overhead);
      for (const part of parts) {
        chunks.push(`${openTag}${part}${closeTag}`);
      }
    } else {
      current = token;
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

export function formatTelegramMessage(text: string, maxLength: number): string[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const segments = splitByCodeFences(normalized);
  const pieces: string[] = [];
  const textMaxLength = Math.max(1000, maxLength - TEXT_LENGTH_MARGIN);

  for (const segment of segments) {
    if (segment.type === 'code') {
      pieces.push(...splitCodeBlock(segment.content, maxLength));
      continue;
    }

    const rawChunks = splitTextPreservingNewlines(segment.content, textMaxLength);
    for (const chunk of rawChunks) {
      const formatted = formatTextChunk(chunk);
      if (formatted.length <= maxLength) {
        pieces.push(formatted);
        continue;
      }
      // Fallback: send escaped plain text to avoid breaking HTML tags
      const plain = escapeHtml(chunk);
      pieces.push(...splitTextPreservingNewlines(plain, maxLength));
    }
  }

  const packed = packPieces(pieces, maxLength);

  // Add chunk markers for multi-part responses so users know more is coming
  if (packed.length > 1) {
    for (let i = 0; i < packed.length; i++) {
      const marker = `[${i + 1}/${packed.length}]`;
      // Prepend marker to first line, or add as suffix for very short chunks
      if (i > 0) {
        packed[i] = `${marker}\n${packed[i]}`;
      }
      // Append continuation hint to all but the last chunk
      if (i < packed.length - 1) {
        packed[i] = `${packed[i]}\n<i>${marker} continued…</i>`;
      }
    }
  }

  return packed;
}
