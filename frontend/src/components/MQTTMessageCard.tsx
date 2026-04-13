import React, { useState } from 'react';
import JsonView from 'react18-json-view';
import 'react18-json-view/src/style.css';

interface MQTTMessageCardProps {
    topic: string;
    payload: string;
    timestamp: string;
    collapseKey?: number;
    expandKey?: number;
}

const MQTTMessageCard: React.FC<MQTTMessageCardProps> = ({ topic, payload, timestamp, collapseKey = 0, expandKey = 0 }) => {
    const [isCollapsed, setIsCollapsed] = useState(true);
    const [prevCollapseKey, setPrevCollapseKey] = useState(collapseKey);
    const [prevExpandKey, setPrevExpandKey] = useState(expandKey);
    const [copied, setCopied] = useState(false);

    // Derived state: sync collapse/expand from parent keys (React-approved setState-during-render pattern)
    if (collapseKey !== prevCollapseKey) {
        setPrevCollapseKey(collapseKey);
        setIsCollapsed(true);
    }
    if (expandKey !== prevExpandKey) {
        setPrevExpandKey(expandKey);
        setIsCollapsed(false);
    }

    let jsonPayload = null;
    try {
        jsonPayload = JSON.parse(payload);
    } catch {
        // Not JSON
    }

    const direction = topic.endsWith('/uplink') ? 'uplink' : topic.endsWith('/downlink') ? 'downlink' : 'other';
    const accentColor = direction === 'uplink'
        ? 'var(--av-accent-cyan)'
        : direction === 'downlink'
        ? 'var(--av-accent-purple)'
        : 'var(--av-accent-amber)';

    const handleCopy = (e: React.MouseEvent) => {
        e.stopPropagation();
        navigator.clipboard.writeText(payload);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div
            className="bg-[var(--av-bg-surface)] rounded border border-[var(--av-border)] border-l-2 overflow-hidden mb-2"
            style={{ borderLeftColor: accentColor }}
        >
            {/* Header */}
            <div
                className="flex items-center justify-between p-3 cursor-pointer hover:bg-[var(--av-bg-raised)] transition-colors"
                onClick={() => setIsCollapsed(!isCollapsed)}
            >
                <div className="flex items-center space-x-3 overflow-hidden">
                    <button
                        className={`transform transition-transform duration-200 text-[var(--av-text-subtle)] ${isCollapsed ? '-rotate-90' : 'rotate-0'}`}
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                    </button>
                    <span
                        className="font-mono text-xs truncate"
                        style={{ color: accentColor }}
                        title={topic}
                    >{topic}</span>
                    <span className="text-[var(--av-text-subtle)] text-xs whitespace-nowrap">{new Date(timestamp).toLocaleTimeString()}</span>
                </div>

                <div className="flex items-center pl-2">
                    <button
                        onClick={handleCopy}
                        className="p-1 hover:bg-[var(--av-bg-raised)] rounded text-[var(--av-text-subtle)] hover:text-[var(--av-accent-cyan)] transition-colors"
                        title="Copy Payload"
                    >
                        {copied ? (
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 text-green-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                        ) : (
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                            </svg>
                        )}
                    </button>
                </div>
            </div>
            {/* Body */}
            {!isCollapsed && (
                <div className="p-3 border-t border-[var(--av-border)] bg-[var(--av-bg-base)] overflow-x-auto">
                    {jsonPayload ? (
                        <JsonView
                            src={jsonPayload}
                            theme="atom"
                            enableClipboard={false}
                            style={{ backgroundColor: 'transparent', fontSize: '12px', fontFamily: 'var(--av-font-mono)' }}
                        />
                    ) : (
                        <div className="text-[var(--av-text-muted)] font-mono text-xs break-all whitespace-pre-wrap">
                            {payload}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default MQTTMessageCard;
