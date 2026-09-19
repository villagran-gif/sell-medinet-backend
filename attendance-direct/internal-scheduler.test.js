import test from 'node:test';
import assert from 'node:assert/strict';
import { schedulerTick } from './internal-scheduler.js';

test('internal scheduler module loads and tick is callable',async()=>{
  assert.equal(typeof schedulerTick,'function');
});
