import { describe, expect, it } from 'vitest'
import { formatMoney } from './format'

describe('formatMoney', () => {
  it.each([
    [null, ''], [0, '0c'], [5, '5c'], [500, '5s 0c'], [12345, '1g 23s 45c'], [10005, '1g 0s 5c'],
    [-2778, '-27s 78c'], [5271.55, '52s 72c'], [-0.4, '0c'], [1234567, '123g 45s 67c'],
  ])('%s -> %s', (v, s) => expect(formatMoney(v)).toBe(s))
})
