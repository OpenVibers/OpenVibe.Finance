'use strict';
// /llms-full.txt (SEO-33): the welcome page llms.txt lists, as words, open to every crawler (11-28: it was a 404 to
// agents, tools/llms-check.js). Signed out, as a crawler sees it: never anyone's money.
const assert = require('assert');
const path = require('node:path');
const crypto = require('node:crypto');
const { createTestDb } = require('openvibe-sdk/testing');
const { createVault } = require('../server/crypto');
const { createApp } = require('../server/app');

(async () => {
    const { db, close } = await createTestDb({ migrations: path.join(__dirname, '..', 'migrations'), store: process.env.FINANCE_TEST_STORE || 'pglite', service: 'finance' });
    const vault = createVault(crypto.randomBytes(32).toString('base64'));
    const auth = { router: (express) => express.Router(), optionalAuth: () => (req, _res, next) => next() };
    const server = createApp({ db, vault, auth }).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
        const r = await fetch(`${base}/llms-full.txt`);
        assert.strictEqual(r.status, 200);
        assert.match(r.headers.get('content-type'), /^text\/plain/);
        assert.ok(!/noindex/.test(r.headers.get('x-robots-tag') || ''), 'open to crawlers');
        const text = await r.text();
        assert.ok(text.startsWith('# OpenVibe.Finance'), 'the same header as llms.txt');
        assert.ok(text.includes('Your money, your rules, your data'), 'the welcome page\'s words');
        assert.ok(text.length > 500 && !/<(?:script|style|section)\b/i.test(text), 'words, not markup');
        const llms = await (await fetch(`${base}/llms.txt`)).text();
        assert.ok(llms.includes('(https://openvibe.finance/llms-full.txt)'), 'llms.txt points at it');
    } finally {
        server.close();
        await close();
    }
    console.log('llms-full: the welcome page as words, linked from llms.txt, open to crawlers');
})().catch((e) => { console.error(e); process.exit(1); });
