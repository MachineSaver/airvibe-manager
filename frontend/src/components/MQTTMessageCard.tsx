import React, { useState } from 'react';
import JsonView from 'react18-json-view';
import 'react18-json-view/src/style.css';

interface MQTTMessageCardProps {
    topic: string;
    payload: string;
    timestamp: string;
}

const MQTTMessageCard: React.FC<MQTTMessageCardProps> = ({ topic, payload, timestamp }) => {
    const [isCollapsed, setIsCollapsed] = useState(false);
    const [copied, setCopied] = useState(false);

    let jsonPayload = null;
    try {
        jsonPayload = JSON.parse(payload);
    } catch (e) {
        // Not JSON
    }

    const handleCopy = (e: React.MouseEvent) => {
        e.stopPropagation();
        navigator.clipboard.writeText(payload);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="bg-[#2d2d2d] rounded border border-[#3e3e42] overflow-hidden mb-2">
            {/* Header */}
            <div
                className="flex items-center justify-between p-3 cursor-pointer hover:bg-[#333333] transition-colors"
                onClick={() => setIsCollapsed(!isCollapsed)}
            >
                <div className="flex items-center space-x-3 overflow-hidden">
                    <button
                        className={`transform transition-transform duration-200 text-gray-400 ${isCollapsed ? '-rotate-90' : 'rotate-0'}`}
                    >
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                    </button>
                    <span className="text-green-400 font-mono text-xs truncate" title={topic}>{topic}</span>
                    <span className="text-gray-500 text-xs whitespace-nowrap">{new Date(timestamp).toLocaleTimeString()}</span>
                </div>

                <div className="flex items-center pl-2">
                    <button
                        onClick={handleCopy}
                        className="p-1 hover:bg-[#3e3e42] rounded text-gray-400 hover:text-blue-400 transition-colors"
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
                <div className="p-3 border-t border-[#3e3e42] bg-[#1e1e1e] overflow-x-auto">
                    {jsonPayload ? (
                        <JsonView
                            src={jsonPayload}
                            theme="atom"
                            enableClipboard={false}
                            style={{ backgroundColor: 'transparent', fontSize: '12px', fontFamily: 'monospace' }}
                        />
                    ) : (
                        <div className="text-gray-300 font-mono text-xs break-all whitespace-pre-wrap">
                            {payload}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

export default MQTTMessageCard;
