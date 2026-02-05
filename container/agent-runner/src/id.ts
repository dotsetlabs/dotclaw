export function generateId(prefix: string): string {
  if (!prefix) return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
