import { normalizeBatteryPct } from './contracts';

describe('normalizeBatteryPct (VANTRA-512 mixed types)', () => {
  it.each([
    ['87%', 87],
    [' 42.5 % ', 42.5],
    [87, 87],
    [63.4, 63.4],
    [undefined, null],
    [null, null],
    ['n/a', null],
    [NaN, null],
    [{}, null],
  ])('%p -> %p', (raw, expected) => {
    expect(normalizeBatteryPct(raw)).toBe(expected);
  });
});
