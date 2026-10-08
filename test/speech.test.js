import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spokenToCode, readBackMatches } from '../public/speech.js';

test('numbers read aloud become the digits and letters they name', () => {
  assert.equal(spokenToCode('seven eight four, one nine nine zero, 1234567 one'), '784199012345671');
  assert.equal(spokenToCode('784 1990 1234567 1'), '784199012345671');
  assert.equal(spokenToCode('seven eight four double one nine oh'), '7841190');
  assert.equal(spokenToCode('november one two three four five six seven'), 'N1234567');
  assert.equal(spokenToCode('N for november, then 1 2 3'), 'N123'); // "N for November" names one letter
  assert.equal(spokenToCode('p as in papa four'), 'P4');
  assert.equal(spokenToCode("it's zed four eight"), '48'); // unknown words are skipped
});

test('read-back matches the box regardless of dashes, spaces and case', () => {
  assert.equal(readBackMatches('784-1990-1234567-1', 'seven eight four 1990 1234567 one').match, true);
  assert.equal(readBackMatches('784-1990-1234567-1', '784 1990 1234567 2').match, false);
  assert.equal(readBackMatches('n1234567', 'November one two three four five six seven').match, true);
  assert.equal(readBackMatches('', 'anything').match, false);
});
