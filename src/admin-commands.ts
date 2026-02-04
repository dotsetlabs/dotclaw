type ParsedCommand = { command: string; args: string[] };

function splitArgs(input: string): string[] {
  const tokens: string[] = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(input)) !== null) {
    tokens.push(match[1] || match[2] || match[3]);
  }
  return tokens;
}

function normalizeCommand(tokens: string[]): ParsedCommand | null {
  if (tokens.length === 0) return null;
  const [firstRaw, secondRaw, ...rest] = tokens;
  const first = firstRaw.toLowerCase();
  const second = secondRaw ? secondRaw.toLowerCase() : '';

  if (first === 'add' && second === 'group') {
    return { command: 'add-group', args: rest };
  }
  if ((first === 'remove' || first === 'delete') && second === 'group') {
    return { command: 'remove-group', args: rest };
  }
  if (first === 'list' && second === 'groups') {
    return { command: 'groups', args: rest };
  }
  if (first === 'set' && second === 'model') {
    return { command: 'set-model', args: rest };
  }
  if (first === 'model') {
    return { command: 'set-model', args: [secondRaw, ...rest].filter(Boolean) as string[] };
  }
  if (first === 'remember') {
    return { command: 'remember', args: [secondRaw, ...rest].filter(Boolean) as string[] };
  }
  if (first === 'style') {
    return { command: 'style', args: [secondRaw, ...rest].filter(Boolean) as string[] };
  }
  if (first === 'tools') {
    return { command: 'tools', args: [secondRaw, ...rest].filter(Boolean) as string[] };
  }
  if (first === 'caution') {
    return { command: 'caution', args: [secondRaw, ...rest].filter(Boolean) as string[] };
  }
  if (first === 'memory') {
    return { command: 'memory', args: [secondRaw, ...rest].filter(Boolean) as string[] };
  }
  if (first === 'groups') {
    return { command: 'groups', args: [secondRaw, ...rest].filter(Boolean) as string[] };
  }
  if (first === 'help') {
    return { command: 'help', args: [] };
  }
  if (first === 'add-group' || first === 'remove-group' || first === 'set-model') {
    return { command: first, args: [secondRaw, ...rest].filter(Boolean) as string[] };
  }
  return null;
}

export function parseAdminCommand(content: string, botUsername?: string): ParsedCommand | null {
  const text = content.trim();
  if (!text) return null;

  if (text.startsWith('/')) {
    const tokens = splitArgs(text.slice(1));
    if (tokens.length === 0) return null;
    const rawCommand = tokens[0];
    const command = rawCommand.split('@')[0].toLowerCase();
    const rest = tokens.slice(1);
    if (command === 'dotclaw' || command === 'dc') {
      return normalizeCommand(rest) || { command: 'help', args: [] };
    }
    if (command === 'help' || command === 'groups') {
      return { command, args: rest };
    }
    return null;
  }

  if (botUsername) {
    const mention = `@${botUsername.toLowerCase()}`;
    if (text.toLowerCase().startsWith(mention)) {
      const remainder = text.slice(mention.length).trim();
      if (!remainder) return null;
      return normalizeCommand(splitArgs(remainder));
    }
  }

  return null;
}

