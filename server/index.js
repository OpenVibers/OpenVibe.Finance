'use strict';
/**
 * OpenVibe.Finance's process: the database (DATABASE_URL through PgBouncer; migrations on DATABASE_DIRECT_URL), the
 * vault (FINANCE_DATA_KEY), sign-in through OpenVibe.Network (OV_OAUTH_CLIENT_ID / OV_OAUTH_CLIENT_SECRET), and the
 * app on 127.0.0.1:PORT (5292). SIGTERM closes the server and the pool.
 */
const path = require('node:path');
const { createDb } = require('openvibe-sdk/db');
const { createSsoClient } = require('openvibe-sdk/sso');
const { createVault } = require('./crypto');
const { createApp } = require('./app');

async function main() {
    const env = process.env;
    const port = Number(env.PORT || 5292);
    const baseUrl = env.BASE_URL || 'https://openvibe.finance';
    const db = createDb({ service: 'finance' });
    await db.migrate({ dir: path.join(__dirname, '..', 'migrations') });
    const vault = createVault(env.FINANCE_DATA_KEY);
    const auth = env.OV_OAUTH_CLIENT_ID && env.OV_OAUTH_CLIENT_SECRET ? createSsoClient({
        site: 'finance', siteName: 'OpenVibe.Finance', baseUrl, clientId: env.OV_OAUTH_CLIENT_ID, clientSecret: env.OV_OAUTH_CLIENT_SECRET,
        networkUrl: env.OV_NETWORK_URL || 'https://openvibe.network', networkInternalUrl: env.OV_NETWORK_INTERNAL_URL || 'http://127.0.0.1:4000',
        secureCookies: env.NODE_ENV === 'production',
    }) : null;
    if (!auth) console.warn('[finance] no OAuth client: sign-in is off');
    const server = createApp({ db, vault, auth, baseUrl }).listen(port, '127.0.0.1', () => console.log(`[finance] listening on 127.0.0.1:${port}`));
    process.on('SIGTERM', () => server.close(async () => { try { await db.close(); } finally { process.exit(0); } }));
}

main().catch((err) => { console.error('[finance] could not start:', err && err.message); process.exit(1); });
