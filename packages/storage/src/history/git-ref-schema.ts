import { z } from 'zod';

export const ManagedGitRefSchema = z
  .string()
  .startsWith('refs/orcaops/')
  .refine(
    (ref) =>
      ![...ref].some(
        (character) =>
          character.charCodeAt(0) <= 32 ||
          character.charCodeAt(0) === 127 ||
          '~^:?*[\\'.includes(character)
      ) &&
      !ref.includes('..') &&
      !ref.includes('@{') &&
      ref
        .split('/')
        .every(
          (part) =>
            part.length > 0 &&
            !part.startsWith('.') &&
            !part.endsWith('.') &&
            !part.endsWith('.lock')
        )
  );

export const GitOidSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
  .refine((oid) => !/^0+$/.test(oid));
