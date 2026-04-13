import React, { useState } from 'react';

interface SegmentMapProps {
    totalSegments: number;
    receivedSegments: number[];
    missingRequested?: number[];
    /** Whether the final segment (TWF / type 0x05) has been received */
    finalSegmentSeen?: boolean;
}

const COLORS = {
    green:  { bg: '#22c55e', border: '#16a34a', label: 'Received' },
    red:    { bg: '#ef4444', border: '#dc2626', label: 'Late/Missing' },
    yellow: { bg: '#eab308', border: '#ca8a04', label: 'Requested' },
    grey:   { bg: '#475569', border: '#334155', label: 'Pending' },
} as const;

type SegState = keyof typeof COLORS;

function getSegmentStates(
    totalSegments: number,
    receivedSegments: number[],
    missingRequested: number[],
    finalSegmentSeen: boolean,
): SegState[] {
    const receivedSet = new Set(receivedSegments);
    const requestedSet = new Set(missingRequested);

    // Find the highest received segment index to detect gaps
    let maxReceived = -1;
    for (const idx of receivedSegments) {
        if (idx > maxReceived) maxReceived = idx;
    }

    const states: SegState[] = [];
    for (let i = 0; i < totalSegments; i++) {
        if (receivedSet.has(i)) {
            states.push('green');
        } else if (requestedSet.has(i)) {
            states.push('yellow');
        } else if (i < maxReceived || finalSegmentSeen) {
            states.push('red');
        } else {
            states.push('grey');
        }
    }
    return states;
}

function SummaryBar({ states, totalSegments }: { states: SegState[], totalSegments: number }) {
    const received = states.filter(s => s === 'green').length;
    const missing = states.filter(s => s === 'red').length;
    const requested = states.filter(s => s === 'yellow').length;
    const pct = totalSegments > 0 ? Math.round((received / totalSegments) * 100) : 0;

    return (
        <div>
            <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-gray-400 mb-1.5">
                <span className="font-bold text-white">{pct}%</span>
                <span>complete</span>
                <span className="text-gray-600">&bull;</span>
                <span>received <span className="text-green-400 font-mono">{received}/{totalSegments}</span></span>
                {missing > 0 && (
                    <>
                        <span className="text-gray-600">&bull;</span>
                        <span>missing <span className="text-red-400 font-mono">{missing}</span></span>
                    </>
                )}
                {requested > 0 && (
                    <>
                        <span className="text-gray-600">&bull;</span>
                        <span>requested <span className="text-yellow-400 font-mono">{requested}</span></span>
                    </>
                )}
            </div>
            {/* Thin segmented progress bar — rendered as a single CSS gradient so it
                displays correctly at any screen width (no sub-pixel flex items). */}
            <div
                className="w-full h-1.5 rounded-full"
                style={{
                    background: states.length > 0
                        ? `linear-gradient(to right, ${states.map((state, i) => {
                            const n = states.length;
                            const start = (i / n * 100).toFixed(2);
                            const end = ((i + 1) / n * 100).toFixed(2);
                            return `${COLORS[state].bg} ${start}% ${end}%`;
                        }).join(', ')})`
                        : 'var(--av-bg-base)',
                }}
            />
        </div>
    );
}

function CircleGrid({ states }: { states: SegState[] }) {
    return (
        <div>
            <div className="flex flex-wrap gap-1 p-3 bg-[var(--av-bg-base)] rounded-lg border border-[var(--av-border)]">
                {states.map((state, i) => {
                    const { bg, border } = COLORS[state];
                    return (
                        <div
                            key={i}
                            className="flex items-center justify-center w-4 h-4 rounded-full text-[6px] font-mono text-white transition-colors duration-300"
                            style={{
                                background: state === 'grey' ? 'transparent' : bg,
                                border: `1.5px solid ${border}`,
                            }}
                            title={`Segment ${i}: ${COLORS[state].label}`}
                        >
                            {i}
                        </div>
                    );
                })}
            </div>
            {/* Legend */}
            <div className="flex flex-wrap gap-3 mt-2 justify-center">
                {Object.values(COLORS).map(({ bg, label }) => (
                    <div key={label} className="flex items-center gap-1 text-[9px] text-gray-500">
                        <span
                            className="w-2 h-2 rounded-full inline-block"
                            style={{
                                background: label === 'Pending' ? 'transparent' : bg,
                                border: `1.5px solid ${label === 'Pending' ? COLORS.grey.border : bg}`,
                            }}
                        />
                        {label}
                    </div>
                ))}
            </div>
        </div>
    );
}

const SegmentMap: React.FC<SegmentMapProps> = ({
    totalSegments,
    receivedSegments,
    missingRequested = [],
    finalSegmentSeen = false,
}) => {
    const [expanded, setExpanded] = useState(false);
    const states = getSegmentStates(totalSegments, receivedSegments, missingRequested, finalSegmentSeen);

    if (totalSegments === 0) {
        return <div className="text-gray-500 text-xs">Waiting for TWIU...</div>;
    }

    return (
        <div>
            {/* Collapsed summary - always visible */}
            <div
                className="flex items-center gap-2 cursor-pointer select-none"
                onClick={() => setExpanded(prev => !prev)}
            >
                <div className="flex-1 min-w-0">
                    <SummaryBar states={states} totalSegments={totalSegments} />
                </div>
                <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className={`h-4 w-4 text-gray-500 shrink-0 transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
                    viewBox="0 0 20 20"
                    fill="currentColor"
                >
                    <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
                </svg>
            </div>

            {/* Expanded circle grid */}
            {expanded && (
                <div className="mt-3">
                    <CircleGrid states={states} />
                </div>
            )}
        </div>
    );
};

export default SegmentMap;
