import assert from 'node:assert/strict';
import { test } from 'vitest';
import { matchingChoices, nextChoice, type SelectChoice } from '../src/ui/select-options.ts';

const choices: SelectChoice[] = [
  { index: 0, value: 'awp', label: 'AWP', group: 'Snipers', disabled: false },
  { index: 1, value: 'ak47', label: 'AK-47', group: 'Rifles', disabled: false },
  { index: 2, value: 'm4', label: 'M4A1 · silenced', group: 'Rifles', disabled: false },
  { index: 3, value: 'crouch', label: '30 · crouch_aim_rifle', group: 'Animation', disabled: true },
  { index: 4, value: 'cafe', label: 'Café corner', group: 'de_inferno', disabled: false },
];

test('selector search handles weapon punctuation, animation underscores, accents and category terms', () => {
  for (const [query, expected] of [
    ['ak47', ['ak47']],
    ['  RIFLES  silenced ', ['m4']],
    ['crouch aim', ['crouch']],
    ['cafe inferno', ['cafe']],
    ['no-such-option', []],
  ] as const)
    assert.deepEqual(
      matchingChoices(choices, query).map((c) => c.value),
      expected,
    );
  assert.equal(matchingChoices(choices, ''), choices);
});

test('selector keyboard movement skips disabled options, wraps and handles empty results', () => {
  assert.equal(nextChoice(choices, -1, 1), 0);
  assert.equal(nextChoice(choices, -1, -1), 4);
  assert.equal(nextChoice(choices, 2, 1), 4);
  assert.equal(nextChoice(choices, 4, -1), 2);
  assert.equal(nextChoice(choices, 4, 1), 0);
  assert.equal(nextChoice([], -1, 1), -1);
  assert.equal(nextChoice([{ ...choices[0], disabled: true }], -1, 1), -1);
});
