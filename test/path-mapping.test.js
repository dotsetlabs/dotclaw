import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  hostPathToContainerGroupPath,
  resolveContainerGroupPathToHost
} from '../dist/path-mapping.js';

test('resolveContainerGroupPathToHost resolves safe group-relative paths', () => {
  const groupsDir = '/var/tmp/dotclaw-groups';
  const resolved = resolveContainerGroupPathToHost('/workspace/group/inbox/file.txt', 'team-alpha', groupsDir);
  assert.equal(resolved, path.resolve('/var/tmp/dotclaw-groups/team-alpha/inbox/file.txt'));
});

test('resolveContainerGroupPathToHost rejects traversal and non-group absolute paths', () => {
  const groupsDir = '/var/tmp/dotclaw-groups';
  assert.equal(resolveContainerGroupPathToHost('../secrets.txt', 'team-alpha', groupsDir), null);
  assert.equal(resolveContainerGroupPathToHost('/workspace/group/../../etc/passwd', 'team-alpha', groupsDir), null);
  assert.equal(resolveContainerGroupPathToHost('/workspace/global/shared.txt', 'team-alpha', groupsDir), null);
});

test('hostPathToContainerGroupPath maps only files inside the target group directory', () => {
  const groupsDir = '/var/tmp/dotclaw-groups';
  const inside = hostPathToContainerGroupPath('/var/tmp/dotclaw-groups/team-alpha/inbox/image.jpg', 'team-alpha', groupsDir);
  const outside = hostPathToContainerGroupPath('/var/tmp/dotclaw-groups/team-beta/inbox/image.jpg', 'team-alpha', groupsDir);

  assert.equal(inside, '/workspace/group/inbox/image.jpg');
  assert.equal(outside, null);
});
