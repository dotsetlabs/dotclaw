import path from 'path';

export function isPathWithinRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function hostPathToContainerGroupPath(hostPath: string, groupFolder: string, groupsDir: string): string | null {
  if (typeof hostPath !== 'string' || !hostPath.trim()) return null;
  const groupDir = path.resolve(path.join(groupsDir, groupFolder));
  const resolvedHostPath = path.resolve(hostPath);
  if (!isPathWithinRoot(resolvedHostPath, groupDir)) {
    return null;
  }
  const rel = path.relative(groupDir, resolvedHostPath);
  if (!rel || rel === '.') return '/workspace/group';
  const relPosix = rel.split(path.sep).join('/');
  return `/workspace/group/${relPosix}`;
}

export function resolveContainerGroupPathToHost(containerPath: string, groupFolder: string, groupsDir: string): string | null {
  if (typeof containerPath !== 'string') return null;
  const trimmedPath = containerPath.trim();
  if (!trimmedPath || trimmedPath.includes('\0')) return null;
  const groupDir = path.resolve(path.join(groupsDir, groupFolder));

  let resolvedPath: string;
  if (path.posix.isAbsolute(trimmedPath)) {
    const normalizedPosix = path.posix.normalize(trimmedPath);
    if (normalizedPosix === '/workspace/group') {
      resolvedPath = groupDir;
    } else if (normalizedPosix.startsWith('/workspace/group/')) {
      const relPosix = normalizedPosix.slice('/workspace/group/'.length);
      const relFs = relPosix.split('/').join(path.sep);
      resolvedPath = path.resolve(groupDir, relFs);
    } else {
      return null;
    }
  } else {
    resolvedPath = path.resolve(groupDir, trimmedPath);
  }

  if (!isPathWithinRoot(resolvedPath, groupDir)) {
    return null;
  }
  return resolvedPath;
}
