"use client";

import { useState } from 'react';

interface CertResult {
  message: string;
  files?: {
    key: string;
    cert: string;
    ca: string;
  };
}

export default function CertificateManager() {
  const [clientId, setClientId] = useState('');
  const [certResult, setCertResult] = useState<CertResult | null>(null);

  const generateCerts = async () => {
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
      const res = await fetch(`${apiUrl}/api/certs/client`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId })
      });
      const data = await res.json();
      setCertResult(data);
    } catch (e) {
      console.error(e);
      alert('Error generating certs');
    }
  };

  return (
    <div className="overflow-auto p-6 h-full">
      <div className="max-w-lg mx-auto bg-[#252526] p-6 rounded-lg border border-[#333]">
        <h2 className="text-lg font-medium mb-4 text-gray-200">Generate Client Certificate</h2>
        <div className="mb-4">
          <label className="block text-xs text-gray-400 mb-1">Client ID / Device EUI</label>
          <input
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="w-full bg-[#1e1e1e] border border-[#3e3e42] rounded p-2 text-gray-200 focus:outline-none focus:border-blue-500"
            placeholder="e.g. device-001"
          />
        </div>
        <button
          onClick={generateCerts}
          className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2 rounded transition-colors"
        >
          Generate & Sign
        </button>

        {certResult && (
          <div className="mt-6 p-4 bg-[#1e1e1e] rounded border border-green-900">
            <div className="text-green-500 mb-2">{certResult.message}</div>
            <div className="text-xs text-gray-400">
              Files generated in <code>certs/</code> volume:
              <ul className="list-disc pl-4 mt-1">
                <li>{certResult.files?.key}</li>
                <li>{certResult.files?.cert}</li>
                <li>{certResult.files?.ca}</li>
              </ul>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
