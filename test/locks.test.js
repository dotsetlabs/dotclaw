import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withGroupLock } from '../dist/locks.js';

test('withGroupLock executes function and returns result', async () => {
  const result = await withGroupLock('test-group', async () => {
    return 42;
  });
  assert.equal(result, 42);
});

test('withGroupLock serializes access to same group', async () => {
  const order = [];

  const p1 = withGroupLock('serial', async () => {
    order.push('start-1');
    await new Promise(resolve => setTimeout(resolve, 50));
    order.push('end-1');
    return 1;
  });

  const p2 = withGroupLock('serial', async () => {
    order.push('start-2');
    await new Promise(resolve => setTimeout(resolve, 10));
    order.push('end-2');
    return 2;
  });

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 1);
  assert.equal(r2, 2);
  // p1 should complete before p2 starts
  assert.deepEqual(order, ['start-1', 'end-1', 'start-2', 'end-2']);
});

test('withGroupLock allows parallel access to different groups', async () => {
  const order = [];

  const p1 = withGroupLock('group-a', async () => {
    order.push('start-a');
    await new Promise(resolve => setTimeout(resolve, 50));
    order.push('end-a');
    return 'a';
  });

  const p2 = withGroupLock('group-b', async () => {
    order.push('start-b');
    await new Promise(resolve => setTimeout(resolve, 10));
    order.push('end-b');
    return 'b';
  });

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1, 'a');
  assert.equal(r2, 'b');
  // Both should start before either finishes
  assert.equal(order[0], 'start-a');
  assert.equal(order[1], 'start-b');
});

test('withGroupLock releases lock on error', async () => {
  // First call should fail
  await assert.rejects(
    withGroupLock('error-group', async () => {
      throw new Error('oops');
    }),
    { message: 'oops' }
  );

  // Second call should still work (lock was released)
  const result = await withGroupLock('error-group', async () => {
    return 'recovered';
  });
  assert.equal(result, 'recovered');
});

test('withGroupLock handles three sequential calls', async () => {
  const order = [];

  const p1 = withGroupLock('triple', async () => {
    order.push(1);
    await new Promise(resolve => setTimeout(resolve, 20));
    return 1;
  });

  const p2 = withGroupLock('triple', async () => {
    order.push(2);
    return 2;
  });

  const p3 = withGroupLock('triple', async () => {
    order.push(3);
    return 3;
  });

  const results = await Promise.all([p1, p2, p3]);
  assert.deepEqual(results, [1, 2, 3]);
  assert.deepEqual(order, [1, 2, 3]);
});
