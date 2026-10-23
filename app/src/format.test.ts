import { describe, expect, it } from 'vitest'
import { formatMoney, formatMoneyShort } from './format'

describe('formatMoney', () => {
  it.each([
    [null, ''], [0, '0c'], [5, '5c'], [500, '5s 0c'], [12345, '1g 23s 45c'], [10005, '1g 0s 5c'],
    [-2778, '-27s 78c'], [5271.55, '52s 72c'], [-0.4, '0c'], [1234567, '123g 45s 67c'],
  ])('%s -> %s', (v, s) => expect(formatMoney(v)).toBe(s))
})

describe('formatMoney, padded for columns', () => {
  it.each([
    [5, '5c'], [500, '5s 00c'], [204, '2s 04c'], [10005, '1g 00s 05c'], [-2708, '-27s 08c'], [1234567, '123g 45s 67c'],
  ])('%s -> %s', (v, s) => expect(formatMoney(v, true)).toBe(s))
})

describe('formatMoneyShort', () => {
  it.each([
    [null, ''], [0, '0c'], [5, '5c'], [3005, '30s 05c'], [163000, '16g 30s'], [163099, '16g 30s'], [10005, '1g 00s'],
    [-27849, '-2g 78s'], [-0.4, '0c'],
  ])('%s -> %s', (v, s) => expect(formatMoneyShort(v)).toBe(s))
})
