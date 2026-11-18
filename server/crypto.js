'use strict';
/**
 * Per-person encryption of the words in a person's money data (plan §L.2, "hosted private: encrypted per person").
 *
 *   const vault = createVault(process.env.FINANCE_DATA_KEY);   // 32 bytes, base64
 *   const sealed = vault.seal(subject, 'Whole Foods');         // 'v1.<iv>.<tag>.<ciphertext>' (base64url)
 *   vault.open(subject, sealed)                                // 'Whole Foods'
 *   vault.mark(subject, 'some text')                           // an HMAC: equal inputs, equal marks (dedupe)
 *
 * Each person's key is HKDF-SHA256 of the service key with their subject as the info, so one person's rows cannot be
 * opened with another's key, and a database copy without the service key reads as noise. This is encryption at rest:
 * the service holds the key and opens a row only to show it to its owner.
 */
const crypto = require('node:crypto');

const SALT = Buffer.from('openvibe-finance/v1');

function createVault(keyBase64) {
    const master = Buffer.from(String(keyBase64 || ''), 'base64');
    if (master.length !== 32) throw new Error('FINANCE_DATA_KEY must be 32 bytes, base64');
    const keys = new Map();
    const keyOf = (subject, use) => {
        const id = `${use}\u0000${subject}`;
        let k = keys.get(id);
        if (!k) {
            k = Buffer.from(crypto.hkdfSync('sha256', master, SALT, Buffer.from(id), 32));
            if (keys.size > 5000) keys.clear();
            keys.set(id, k);
        }
        return k;
    };
    const subjectOk = (subject) => {
        if (!/^usr_[0-9A-Za-z]{10,40}$/.test(String(subject || ''))) throw new Error('a person (usr_ subject) is required');
    };
    function seal(subject, text) {
        subjectOk(subject);
        const plain = String(text == null ? '' : text);
        if (!plain) return '';
        const iv = crypto.randomBytes(12);
        const c = crypto.createCipheriv('aes-256-gcm', keyOf(subject, 'seal'), iv);
        const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
        return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
    }
    function open(subject, sealed) {
        subjectOk(subject);
        if (!sealed) return '';
        const [v, iv, tag, body] = String(sealed).split('.');
        if (v !== 'v1' || !iv || !tag || body == null) throw new Error('not a sealed value');
        const d = crypto.createDecipheriv('aes-256-gcm', keyOf(subject, 'seal'), Buffer.from(iv, 'base64url'));
        d.setAuthTag(Buffer.from(tag, 'base64url'));
        return Buffer.concat([d.update(Buffer.from(body, 'base64url')), d.final()]).toString('utf8');
    }
    function mark(subject, text) {
        subjectOk(subject);
        return crypto.createHmac('sha256', keyOf(subject, 'mark')).update(String(text)).digest('base64url');
    }
    return { seal, open, mark };
}

module.exports = { createVault };
