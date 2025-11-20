const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('util');

const execPromise = util.promisify(exec);
const CERTS_DIR = process.env.CERTS_DIR || '/app/certs';

// Ensure certs directory exists
if (!fs.existsSync(CERTS_DIR)) {
    try {
        fs.mkdirSync(CERTS_DIR, { recursive: true });
    } catch (e) {
        console.error(`Could not create certs dir at ${CERTS_DIR}`, e);
    }
}

async function generateCA(domain) {
    const subject = `/C=US/ST=State/L=City/O=MyOrg/OU=IoT/CN=${domain}`;

    try {
        // Generate CA Key
        await execPromise(`openssl genrsa -out ${path.join(CERTS_DIR, 'ca.key')} 2048`);

        // Generate CA Certificate
        await execPromise(`openssl req -x509 -new -nodes -key ${path.join(CERTS_DIR, 'ca.key')} -sha256 -days 3650 -out ${path.join(CERTS_DIR, 'ca.crt')} -subj "${subject}"`);

        return { success: true, message: 'CA Generated' };
    } catch (error) {
        console.error('Error generating CA:', error);
        throw error;
    }
}

async function generateServerCert(domain) {
    const subject = `/C=US/ST=State/L=City/O=MyOrg/OU=IoT/CN=${domain}`;

    try {
        // Generate Server Key
        await execPromise(`openssl genrsa -out ${path.join(CERTS_DIR, 'server.key')} 2048`);

        // Generate Server CSR
        await execPromise(`openssl req -new -key ${path.join(CERTS_DIR, 'server.key')} -out ${path.join(CERTS_DIR, 'server.csr')} -subj "${subject}"`);

        // Sign Server Cert with CA
        await execPromise(`openssl x509 -req -in ${path.join(CERTS_DIR, 'server.csr')} -CA ${path.join(CERTS_DIR, 'ca.crt')} -CAkey ${path.join(CERTS_DIR, 'ca.key')} -CAcreateserial -out ${path.join(CERTS_DIR, 'server.crt')} -days 365 -sha256`);

        return { success: true, message: 'Server Cert Generated' };
    } catch (error) {
        console.error('Error generating Server Cert:', error);
        throw error;
    }
}

async function generateClientCert(clientId) {
    const subject = `/C=US/ST=State/L=City/O=MyOrg/OU=IoT/CN=${clientId}`;
    const clientKeyPath = path.join(CERTS_DIR, `${clientId}.key`);
    const clientCsrPath = path.join(CERTS_DIR, `${clientId}.csr`);
    const clientCrtPath = path.join(CERTS_DIR, `${clientId}.crt`);

    try {
        // Generate Client Key
        await execPromise(`openssl genrsa -out ${clientKeyPath} 2048`);

        // Generate Client CSR
        await execPromise(`openssl req -new -key ${clientKeyPath} -out ${clientCsrPath} -subj "${subject}"`);

        // Sign Client Cert with CA
        await execPromise(`openssl x509 -req -in ${clientCsrPath} -CA ${path.join(CERTS_DIR, 'ca.crt')} -CAkey ${path.join(CERTS_DIR, 'ca.key')} -CAcreateserial -out ${clientCrtPath} -days 365 -sha256`);

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
        console.error(`Error generating Client Cert for ${clientId}:`, error);
        throw error;
    }
}

module.exports = {
    generateCA,
    generateServerCert,
    generateClientCert
};
