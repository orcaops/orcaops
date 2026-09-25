import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';

import { digestTable } from './content-digest.js';

const databases: Database.Database[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function holding(...statements: string[]): Database.Database {
  const database = new Database(':memory:');
  databases.push(database);
  for (const statement of statements) database.exec(statement);
  return database;
}

const digestOf = (database: Database.Database, columns?: readonly string[]) =>
  digestTable(database, 'records', columns);

it('tells a text value from the integer that prints the same', () => {
  const text = holding('CREATE TABLE records (value)', "INSERT INTO records VALUES ('1')");
  const integer = holding('CREATE TABLE records (value)', 'INSERT INTO records VALUES (1)');

  expect(digestOf(text).rows).toBe(digestOf(integer).rows);
  expect(digestOf(text).sha256).not.toBe(digestOf(integer).sha256);
});

it('never runs two values or two rows together into the same bytes', () => {
  const twoRows = holding('CREATE TABLE records (value)', "INSERT INTO records VALUES ('a'),('b')");
  const oneRow = holding('CREATE TABLE records (value)', "INSERT INTO records VALUES ('ab')");
  const split = holding(
    'CREATE TABLE records (left, right)',
    "INSERT INTO records VALUES ('a','bc')"
  );
  const shifted = holding(
    'CREATE TABLE records (left, right)',
    "INSERT INTO records VALUES ('ab','c')"
  );

  expect(digestOf(twoRows).sha256).not.toBe(digestOf(oneRow).sha256);
  expect(digestOf(split).sha256).not.toBe(digestOf(shifted).sha256);
});

it('reads a different digest when the same rows are stored in a different order', () => {
  const ascending = holding(
    'CREATE TABLE records (value)',
    "INSERT INTO records VALUES ('a'),('b')"
  );
  const descending = holding(
    'CREATE TABLE records (value)',
    "INSERT INTO records VALUES ('b'),('a')"
  );

  expect(digestOf(ascending).sha256).not.toBe(digestOf(descending).sha256);
});

it('digests a table without row ids in primary-key order, whatever order its rows arrived in', () => {
  const definition = 'CREATE TABLE records (key TEXT PRIMARY KEY, value) WITHOUT ROWID';
  const inKeyOrder = holding(definition, "INSERT INTO records VALUES ('a',1),('b',2)");
  const reversed = holding(definition, "INSERT INTO records VALUES ('b',2),('a',1)");
  const byRowId = holding(
    'CREATE TABLE records (key TEXT PRIMARY KEY, value)',
    "INSERT INTO records VALUES ('a',1),('b',2)"
  );

  expect(digestOf(reversed)).toEqual(digestOf(inKeyOrder));
  expect(digestOf(inKeyOrder)).toEqual(digestOf(byRowId));
});

it('digests a rebuilt table as its predecessor over the columns they share', () => {
  const released = holding(
    'CREATE TABLE records (name, position)',
    "INSERT INTO records VALUES ('a',1),('b',2)"
  );
  const rebuilt = holding(
    'CREATE TABLE records (name, position, standing)',
    "INSERT INTO records VALUES ('a',1,'established'),('b',2,NULL)"
  );

  expect(digestOf(rebuilt, ['name', 'position'])).toEqual(digestOf(released));
  expect(digestOf(rebuilt).sha256).not.toBe(digestOf(released).sha256);
});
