# DotClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Container agents | Sandboxed | Isolated execution environment |
| Telegram messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Container Isolation (Primary Boundary)

Agents execute in Docker containers, providing:
- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Only explicitly mounted directories are visible
- **Non-root execution** - Runs as unprivileged `node` user (uid 1000)
- **Ephemeral containers** - Fresh environment per invocation (`--rm`)
- **Runtime hardening** - Drops Linux caps, enables no-new-privileges, and sets PID limits

### UID/GID Alignment (Linux)

On Linux/VPS, containers run with the host UID/GID by default to avoid permission errors on mounted volumes.  
You can override with `CONTAINER_RUN_UID` and `CONTAINER_RUN_GID` if needed.

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what's mounted.

### 2. Mount Security

**External Allowlist** - Mount permissions stored at `~/.config/dotclaw/mount-allowlist.json`, which is:
- Outside project root
- Never mounted into containers
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups

### 3. Session Isolation

Each group has isolated OpenRouter sessions at `data/sessions/{group}/openrouter/`:
- Groups cannot see other groups' conversation history
- Session data includes full message history and memory summaries
- Prevents cross-group information disclosure

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |
| Set model | ✓ | ✗ |

### 5. Credential Handling

**Mounted Credentials:**
- OpenRouter API key and model config (filtered from `.env`, read-only)
- Brave Search API key (optional, for WebSearch)

**NOT Mounted:**
- Telegram session (`store/auth/`) - host only
- Mount allowlist - external, never mounted
- Any credentials matching blocked patterns

**Credential Filtering:**
Only these environment variables are exposed to containers:
```typescript
const allowedVars = [
  'OPENROUTER_API_KEY',
  'OPENROUTER_MODEL',
  'OPENROUTER_SITE_URL',
  'OPENROUTER_SITE_NAME',
  'BRAVE_SEARCH_API_KEY',
  'ASSISTANT_NAME'
];
const allowedPrefixes = ['DOTCLAW_'];
```

> **Note:** OpenRouter and Brave credentials are mounted so the agent can authenticate. This means the agent can discover these credentials via Bash or file operations. Further isolation would require external secret management.

### 6. Outbound Network Guardrails

By default `WebFetch` blocks private and local network targets to reduce SSRF risk.  
You can override with:
```bash
DOTCLAW_WEBFETCH_BLOCK_PRIVATE=false
```
Allow/deny lists remain supported via `DOTCLAW_WEBFETCH_ALLOWLIST` and `DOTCLAW_WEBFETCH_BLOCKLIST`.

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | `/workspace/project` (rw) | None |
| Group folder | `/workspace/group` (rw) | `/workspace/group` (rw) |
| Global memory | Implicit via project | `/workspace/global` (ro) |
| Additional mounts | Configurable | Read-only unless allowed |
| Network access | Unrestricted | Unrestricted |
| MCP tools | All | All |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  Telegram Messages (potentially malicious)                        │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Mention/reply check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • IPC authorization                                              │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • Credential filtering                                           │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only
┌──────────────────────────────────────────────────────────────────┐
│                CONTAINER (ISOLATED/SANDBOXED)                     │
│  • Agent execution                                                │
│  • Bash commands (sandboxed)                                      │
│  • File operations (limited to mounts)                            │
│  • Network access (unrestricted)                                  │
│  • Cannot modify security config                                  │
└──────────────────────────────────────────────────────────────────┘
```
