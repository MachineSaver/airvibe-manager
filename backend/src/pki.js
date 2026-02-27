const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');
const log = require('./logger').child({ module: 'pki' });

const execFilePromise = util.promisify(execFile);
const CERTS_DIR = process.env.CERTS_DIR || '/app/certs';

// Validate identifiers to prevent command injection.
// Allows alphanumeric, hyphens, underscores, and dots only.
const SAFE_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

function validateId(value, label) {
    if (!value || typeof value !== 'string') {
        throw new Error(`${label} is required`);
    }
    if (value.length > 253) {
        throw new Error(`${label} exceeds maximum length of 253 characters`);
    }
    if (!SAFE_ID_PATTERN.test(value)) {
        throw new Error(`${label} contains invalid characters. Only alphanumeric, hyphens, underscores, and dots are allowed.`);
    }
}

// Ensure certs directory exists
if (!fs.existsSync(CERTS_DIR)) {
    try {
        fs.mkdirSync(CERTS_DIR, { recursive: true });
    } catch (e) {
        log.error({ err: e }, `Could not create certs dir at ${CERTS_DIR}`);
    }
}

async function generateCA(domain) {
    validateId(domain, 'domain');

    const caKeyPath = path.join(CERTS_DIR, 'ca.key');
    const caCrtPath = path.join(CERTS_DIR, 'ca.crt');

    if (fs.existsSync(caKeyPath) && fs.existsSync(caCrtPath)) {
        log.info('CA Certificate already exists. Skipping generation.');
        return { success: true, message: 'CA already exists' };
    }

    const subject = `/C=US/ST=State/L=City/O=MyOrg/OU=IoT/CN=${domain}`;

    try {
        await execFilePromise('openssl', ['genrsa', '-out', caKeyPath, '2048']);
        fs.chmodSync(caKeyPath, 0o600);
        await execFilePromise('openssl', [
            'req', '-x509', '-new', '-nodes',
            '-key', caKeyPath, '-sha256', '-days', '3650',
            '-out', caCrtPath, '-subj', subject
        ]);

        return { success: true, message: 'CA Generated' };
    } catch (error) {
        log.error({ err: error }, 'Error generating CA');
        throw error;
    }
}

async function generateServerCert(domain) {
    validateId(domain, 'domain');

    const serverKeyPath = path.join(CERTS_DIR, 'server.key');
    const serverCrtPath = path.join(CERTS_DIR, 'server.crt');

    if (fs.existsSync(serverKeyPath) && fs.existsSync(serverCrtPath)) {
        log.info('Server Certificate already exists. Skipping generation.');
        return { success: true, message: 'Server Cert already exists' };
    }

    const subject = `/C=US/ST=State/L=City/O=MyOrg/OU=IoT/CN=${domain}`;
    const serverCsrPath = path.join(CERTS_DIR, 'server.csr');
    const serverExtPath = path.join(CERTS_DIR, 'server.ext');

    try {
        // Write SAN extension file so TLS clients can verify the hostname
        fs.writeFileSync(serverExtPath, `subjectAltName=DNS:${domain}\n`);

        await execFilePromise('openssl', ['genrsa', '-out', serverKeyPath, '2048']);
        fs.chmodSync(serverKeyPath, 0o600);
        await execFilePromise('openssl', [
            'req', '-new', '-key', serverKeyPath,
            '-out', serverCsrPath, '-subj', subject
        ]);
        await execFilePromise('openssl', [
            'x509', '-req', '-in', serverCsrPath,
            '-CA', path.join(CERTS_DIR, 'ca.crt'),
            '-CAkey', path.join(CERTS_DIR, 'ca.key'),
            '-CAcreateserial', '-out', serverCrtPath,
            '-days', '365', '-sha256',
            '-extfile', serverExtPath
        ]);

        return { success: true, message: 'Server Cert Generated' };
    } catch (error) {
        log.error({ err: error }, 'Error generating Server Cert');
        throw error;
    }
}

async function generateClientCert(clientId) {
    validateId(clientId, 'clientId');

    const subject = `/C=US/ST=State/L=City/O=MyOrg/OU=IoT/CN=${clientId}`;
    const clientKeyPath = path.join(CERTS_DIR, `${clientId}.key`);
    const clientCsrPath = path.join(CERTS_DIR, `${clientId}.csr`);
    const clientCrtPath = path.join(CERTS_DIR, `${clientId}.crt`);

    try {
        await execFilePromise('openssl', ['genrsa', '-out', clientKeyPath, '2048']);
        fs.chmodSync(clientKeyPath, 0o600);
        await execFilePromise('openssl', [
            'req', '-new', '-key', clientKeyPath,
            '-out', clientCsrPath, '-subj', subject
        ]);
        await execFilePromise('openssl', [
            'x509', '-req', '-in', clientCsrPath,
            '-CA', path.join(CERTS_DIR, 'ca.crt'),
            '-CAkey', path.join(CERTS_DIR, 'ca.key'),
            '-CAcreateserial', '-out', clientCrtPath,
            '-days', '365', '-sha256'
        ]);

        return {
            success: true,
            message: `Client Cert for ${clientId} Generated`,
            files: {
                key: `${clientId}.key`,
                cert: `${clientId}.crt`,
                ca: 'ca.crt'
            }
        };
    } catch (error) {
        log.error({ err: error }, `Error generating Client Cert for ${clientId}`);
        throw error;
    }
}

module.exports = {
    generateCA,
    generateServerCert,
    generateClientCert
};
