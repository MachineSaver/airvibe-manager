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
    const caKeyPath = path.join(CERTS_DIR, 'ca.key');
    const caCrtPath = path.join(CERTS_DIR, 'ca.crt');

    if (fs.existsSync(caKeyPath) && fs.existsSync(caCrtPath)) {
        console.log('CA Certificate already exists. Skipping generation.');
        return { success: true, message: 'CA already exists' };
    }

    const subject = `/C=US/ST=State/L=City/O=MyOrg/OU=IoT/CN=${domain}`;

    try {
        // Generate CA Key
        await execPromise(`openssl genrsa -out ${caKeyPath} 2048`);

        // Generate CA Certificate
        await execPromise(`openssl req -x509 -new -nodes -key ${caKeyPath} -sha256 -days 3650 -out ${caCrtPath} -subj "${subject}"`);

        return { success: true, message: 'CA Generated' };
    } catch (error) {
        console.error('Error generating CA:', error);
        throw error;
    }
}

async function generateServerCert(domain) {
    const serverKeyPath = path.join(CERTS_DIR, 'server.key');
    const serverCrtPath = path.join(CERTS_DIR, 'server.crt');

    if (fs.existsSync(serverKeyPath) && fs.existsSync(serverCrtPath)) {
        console.log('Server Certificate already exists. Skipping generation.');
        return { success: true, message: 'Server Cert already exists' };
    }

    const subject = `/C=US/ST=State/L=City/O=MyOrg/OU=IoT/CN=${domain}`;

    try {
        // Generate Server Key
        await execPromise(`openssl genrsa -out ${serverKeyPath} 2048`);

        // Generate Server CSR
        await execPromise(`openssl req -new -key ${serverKeyPath} -out ${path.join(CERTS_DIR, 'server.csr')} -subj "${subject}"`);

        // Sign Server Cert with CA
        await execPromise(`openssl x509 -req -in ${path.join(CERTS_DIR, 'server.csr')} -CA ${path.join(CERTS_DIR, 'ca.crt')} -CAkey ${path.join(CERTS_DIR, 'ca.key')} -CAcreateserial -out ${serverCrtPath} -days 365 -sha256`);

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
