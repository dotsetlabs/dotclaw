/**
 * User-friendly error message mapping
 * Converts technical errors to human-readable messages
 */

const ERROR_PATTERNS: Array<{ pattern: RegExp | string; message: string }> = [
  // Network errors
  { pattern: 'ECONNREFUSED', message: "I'm having trouble connecting to a service. Please try again in a moment." },
  { pattern: 'ETIMEDOUT', message: "That took too long to complete. Let me try a simpler approach." },
  { pattern: 'ENOTFOUND', message: "I couldn't reach a required service. Please check your internet connection." },
  { pattern: 'ECONNRESET', message: "The connection was interrupted. Please try again." },
  { pattern: 'EAI_AGAIN', message: "There was a temporary network issue. Please try again." },

  // Rate limiting
  { pattern: /rate.?limit/i, message: "I need to slow down a bit. Please try again in a few seconds." },
  { pattern: /too many requests/i, message: "I'm being rate limited. Please wait a moment and try again." },
  { pattern: /429/i, message: "I'm being rate limited. Please wait a moment and try again." },

  // Context/token limits
  { pattern: /context.?length/i, message: "That conversation got too long. Let me summarize and continue." },
  { pattern: /maximum.?context/i, message: "We've hit the context limit. I'll need to start fresh or summarize." },
  { pattern: /token.?limit/i, message: "The response was too long. Let me give you a shorter version." },

  // Authentication
  { pattern: /invalid.?api.?key/i, message: "There's a configuration issue with the API. Please contact the admin." },
  { pattern: /unauthorized/i, message: "There's an authentication issue. Please contact the admin." },
  { pattern: /401/i, message: "There's an authentication issue. Please contact the admin." },
  { pattern: /403/i, message: "I don't have permission to do that. Please contact the admin." },

  // Model errors
  { pattern: /model.?not.?found/i, message: "The AI model isn't available right now. Trying an alternative..." },
  { pattern: /model.?not.?available/i, message: "The AI model is currently unavailable. Please try again later." },
  { pattern: /model.?unavailable/i, message: "The AI model is temporarily unavailable. Please try again later." },
  { pattern: /overloaded/i, message: "The AI service is busy right now. Please try again in a moment." },

  // Payment / credit errors
  { pattern: /402/, message: "API credits have run out. Please contact the admin." },
  { pattern: /insufficient.?credit/i, message: "API credits have run out. Please contact the admin." },
  { pattern: /payment.?required/i, message: "API credits have run out. Please contact the admin." },

  // Container errors
  { pattern: /container.?timeout/i, message: "That task took too long to complete. Please try with a smaller request." },
  { pattern: /container.?exited/i, message: "Something went wrong while processing. Let me try again." },
  { pattern: /Invalid JSON in container output/i, message: "I ran into a technical error while processing. Please try again." },
  { pattern: /stdout truncated/i, message: "The response was too large to deliver. Try asking for a smaller piece." },
  { pattern: /Container output missing/i, message: "I ran into a technical error while processing. Please try again." },

  // Tool errors
  { pattern: /tool.?call.?limit/i, message: "I hit my limit for operations. Please narrow the scope or ask for a specific subtask." },
  { pattern: /bash.?timeout/i, message: "A command took too long to run. Please try a simpler operation." },

  // Generic server errors — use word boundaries to avoid matching port numbers, IDs, etc.
  { pattern: /\b500\b/, message: "The server encountered an error. Please try again." },
  { pattern: /\b502\b/, message: "There's a temporary server issue. Please try again in a moment." },
  { pattern: /\b503\b/, message: "The service is temporarily unavailable. Please try again later." },
  { pattern: /\b504\b/, message: "The request timed out. Please try again." },

  // Memory/resource errors
  { pattern: /out of memory/i, message: "That task needed more memory than available. Please try with less data." },
  { pattern: /memory.?limit/i, message: "That task needed more memory than available. Please try with less data." },

  // Interrupt
  { pattern: /interrupted/i, message: "Got your new message — working on that instead." },

  // Fallback chain exhaustion
  { pattern: /All models failed/i, message: "All available models are down right now. Please try again in a minute." }
];

/**
 * Convert a technical error to a user-friendly message
 */
export function humanizeError(error: Error | string): string {
  const message = typeof error === 'string' ? error : error.message;

  for (const { pattern, message: friendlyMessage } of ERROR_PATTERNS) {
    if (typeof pattern === 'string') {
      if (message.includes(pattern)) {
        return friendlyMessage;
      }
    } else if (pattern.test(message)) {
      return friendlyMessage;
    }
  }

  // Default message
  return "Something went wrong. I'll try to help anyway!";
}

/**
 * Check if an error is likely transient and worth retrying
 */
export function isTransientError(error: Error | string): boolean {
  const message = typeof error === 'string' ? error : error.message;
  const transientPatterns = [
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ECONNRESET',
    'EAI_AGAIN',
    /rate.?limit/i,
    /429/i,
    /overloaded/i,
    /502/i,
    /503/i,
    /504/i
  ];

  for (const pattern of transientPatterns) {
    if (typeof pattern === 'string') {
      if (message.includes(pattern)) return true;
    } else if (pattern.test(message)) {
      return true;
    }
  }

  return false;
}

/**
 * Determine if an error should be logged at error level vs warning
 */
export function getErrorSeverity(error: Error | string): 'error' | 'warn' | 'info' {
  const message = typeof error === 'string' ? error : error.message;

  // Transient errors are warnings
  if (isTransientError(error)) {
    return 'warn';
  }

  // Configuration issues are errors
  if (/invalid.?api.?key/i.test(message) || /unauthorized/i.test(message)) {
    return 'error';
  }

  // User-caused issues (context too long, etc) are info
  if (/context.?length/i.test(message) || /token.?limit/i.test(message)) {
    return 'info';
  }

  return 'error';
}
