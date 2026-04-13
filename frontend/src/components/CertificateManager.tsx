"use client";

import { useState } from 'react';

interface CertResult {
  message: string;
  error?: boolean;
  files?: {
    key: string;
    cert: string;
    ca: string;
  };
}

export default function CertificateManager() {
  const [clientId, setClientId] = useState('');
  const [certResult, setCertResult] = useState<CertResult | null>(null);

  const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

  const generateCerts = async () => {
    try {
      const res = await fetch(`${apiUrl}/api/certs/client`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId })
      });
      const data = await res.json();
      if (!res.ok || data.success === false) {
        setCertResult({ message: data.error || `Server error (${res.status})`, error: true });
        return;
      }
      setCertResult(data);
    } catch (e) {
      console.error(e);
      setCertResult({ message: 'Network error — could not reach backend', error: true });
    }
  };

  return (
    <div className="overflow-auto p-6 h-full">
      <div className="max-w-lg mx-auto bg-[var(--av-bg-surface)] p-6 rounded-lg border border-[var(--av-border)]">
        <h2 className="text-lg font-medium mb-4 text-[var(--av-text-primary)]">Generate Client Certificate</h2>
        <div className="mb-4">
          <label className="block text-xs text-[var(--av-text-subtle)] mb-1">Client ID / Device EUI</label>
          <input
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className="w-full bg-[var(--av-bg-base)] border border-[var(--av-border)] rounded p-2 text-[var(--av-text-muted)] focus:outline-none focus:border-[var(--av-accent-cyan)]"
            placeholder="e.g. device-001"
          />
        </div>
        <button
          onClick={generateCerts}
          className="w-full bg-[var(--av-accent-cyan)] hover:opacity-90 text-[var(--av-bg-base)] py-2 rounded transition-opacity font-medium"
        >
          Generate & Sign
        </button>

        {certResult && (
          <div className={`mt-6 p-4 bg-[var(--av-bg-base)] rounded border ${certResult.error ? 'border-[var(--av-accent-red)]/40' : 'border-[var(--av-accent)]/40'}`}>
            <div className={`${certResult.error ? 'text-[var(--av-accent-red)]' : 'text-[var(--av-accent)]'} mb-2`}>{certResult.message}</div>
            {certResult.files && (
              <div className="text-xs text-[var(--av-text-subtle)]">
                Files generated:
                <ul className="list-disc pl-4 mt-1 space-y-1">
                  {[certResult.files.key, certResult.files.cert, certResult.files.ca].map((file) => (
                    <li key={file}>
                      <button
                        onClick={() => window.open(`${apiUrl}/api/certs/download/${file}`, '_blank')}
                        className="text-[var(--av-accent-cyan)] hover:text-[var(--av-text-primary)] underline"
                      >
                        {file}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
