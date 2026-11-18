'use strict';
// The vault (server/crypto.js): a person's words sealed with their key alone, opened only with it, tamper refused.
const assert = require('assert');
const crypto = require('node:crypto');
const { createVault } = require('../server/crypto');

const ADA = 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAW';
const BO = 'usr_01JCZ3NDEKTSV4RRFFQ69G5FAX';
const vault = createVault(crypto.randomBytes(32).toString('base64'));

const sealed = vault.seal(ADA, 'Corner Grocer');
assert.match(sealed, /^v1\./);
assert.ok(!sealed.includes('Corner'), 'the words are not readable');
assert.strictEqual(vault.open(ADA, sealed), 'Corner Grocer');
assert.notStrictEqual(vault.seal(ADA, 'Corner Grocer'), sealed, 'a fresh IV each time');
assert.throws(() => vault.open(BO, sealed), 'another person\'s key does not open it');
const parts = sealed.split('.');
parts[3] = Buffer.from('tampered').toString('base64url');
assert.throws(() => vault.open(ADA, parts.join('.')), 'a changed value is refused');
assert.strictEqual(vault.seal(ADA, ''), '');
assert.strictEqual(vault.open(ADA, ''), '');
assert.strictEqual(vault.mark(ADA, 'x'), vault.mark(ADA, 'x'), 'a mark is stable');
assert.notStrictEqual(vault.mark(ADA, 'x'), vault.mark(BO, 'x'), 'and per person');
assert.throws(() => vault.seal('nobody', 'x'), /usr_/);
assert.throws(() => createVault('short'), /32 bytes/);
console.log('vault: sealed per person, refused for others and when changed');
