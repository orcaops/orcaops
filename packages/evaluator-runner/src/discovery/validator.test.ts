import { describe, expect, it } from 'vitest';

import { createParamsValidator } from './validator.js';

describe('createParamsValidator', () => {
  it('passes when params satisfy the schema', () => {
    const validate = createParamsValidator();
    expect(() =>
      validate(
        { threshold: 0.6 },
        {
          type: 'object',
          properties: { threshold: { type: 'number', minimum: 0, maximum: 1 } },
          required: ['threshold'],
        }
      )
    ).not.toThrow();
  });

  it('throws on a missing required field with the field path in the message', () => {
    const validate = createParamsValidator();
    expect(() =>
      validate(
        {},
        {
          type: 'object',
          properties: { threshold: { type: 'number' } },
          required: ['threshold'],
        }
      )
    ).toThrow(/threshold|required/);
  });

  it('throws on a value out of range', () => {
    const validate = createParamsValidator();
    expect(() =>
      validate(
        { threshold: 1.5 },
        {
          type: 'object',
          properties: { threshold: { type: 'number', minimum: 0, maximum: 1 } },
          required: ['threshold'],
        }
      )
    ).toThrow(/maximum|threshold/);
  });

  it('throws on additionalProperties: false rejecting an unknown key', () => {
    const validate = createParamsValidator();
    expect(() =>
      validate(
        { unknown: true },
        {
          type: 'object',
          properties: {},
          additionalProperties: false,
        }
      )
    ).toThrow();
  });

  it('throws on a string failing the enum constraint', () => {
    const validate = createParamsValidator();
    expect(() =>
      validate(
        { surface: 'oops' },
        {
          type: 'object',
          properties: { surface: { type: 'string', enum: ['plan', 'checkpoint', 'summary'] } },
          required: ['surface'],
        }
      )
    ).toThrow(/surface|enum/);
  });

  it('compiles each unique schema once (smoke check — multiple invocations work)', () => {
    const validate = createParamsValidator();
    const schema = { type: 'object', properties: { x: { type: 'integer' } } } as const;
    expect(() => validate({ x: 1 }, schema as Record<string, unknown>)).not.toThrow();
    expect(() => validate({ x: 2 }, schema as Record<string, unknown>)).not.toThrow();
    expect(() => validate({ x: 'no' }, schema as Record<string, unknown>)).toThrow();
  });
});
