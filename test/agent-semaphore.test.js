import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LaneAwareSemaphore } from '../dist/agent-semaphore.js';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('lane-aware semaphore prioritizes scheduled work after interactive burst cap', async () => {
  const semaphore = new LaneAwareSemaphore(1, {
    laneStarvationMs: 60_000,
    maxConsecutiveInteractive: 1
  });
  const dispatchOrder = [];

  const releaseInitial = await semaphore.acquire('interactive');
  const queuedInteractive = semaphore.acquire('interactive').then(release => {
    dispatchOrder.push('interactive');
    release();
  });
  const queuedScheduled = semaphore.acquire('scheduled').then(release => {
    dispatchOrder.push('scheduled');
    release();
  });

  releaseInitial();
  await Promise.all([queuedInteractive, queuedScheduled]);

  assert.deepEqual(dispatchOrder, ['scheduled', 'interactive']);
});

test('lane-aware semaphore prevents starvation for low-priority lane', async () => {
  const semaphore = new LaneAwareSemaphore(1, {
    laneStarvationMs: 20,
    maxConsecutiveInteractive: 100
  });
  const dispatchOrder = [];

  const releaseInitial = await semaphore.acquire('interactive');
  const queuedMaintenance = semaphore.acquire('maintenance').then(release => {
    dispatchOrder.push('maintenance');
    release();
  });
  const queuedInteractive = semaphore.acquire('interactive').then(release => {
    dispatchOrder.push('interactive');
    release();
  });

  await sleep(40);
  releaseInitial();
  await Promise.all([queuedMaintenance, queuedInteractive]);

  assert.deepEqual(dispatchOrder, ['maintenance', 'interactive']);
});
