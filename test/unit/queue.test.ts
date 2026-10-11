import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from '../../src/jobs/queue.ts';

test('canonicalJson ignores key order at every depth', () => {
  assert.equal(
    canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: 2 } }),
    canonicalJson({ a: { c: 2, d: [3, { x: 2, y: 1 }] }, b: 1 }),
  );
  assert.notEqual(canonicalJson({ a: [1, 2] }), canonicalJson({ a: [2, 1] }));
});
