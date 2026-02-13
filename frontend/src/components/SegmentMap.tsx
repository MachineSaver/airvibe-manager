import React from 'react';

interface SegmentMapProps {
    totalSegments: number;
    receivedSegments: number[];
    missingRequested?: number[];
    /** Whether the final segment (TWF / type 0x05) has been received */
    finalSegmentSeen?: boolean;
}

const COLORS = {
    green:  { bg: '#22c55e', border: '#16a34a', label: 'Received' },
    red:    { bg: '#ef4444', border: '#dc2626', label: 'Missing' },
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
            // Gap: a higher-indexed segment was received (or final arrived) but this one is missing
            states.push('red');
        } else {
            states.push('grey');
        }
    }
    return states;
}

function Legend() {
    return (
        <div className="flex flex-wrap gap-3">
            {Object.values(COLORS).map(({ bg, label }) => (
                <div key={label} className="flex items-center gap-1.5 text-[10px] text-gray-500">
                    <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: bg }} />
                    {label}
                </div>
            ))}
        </div>
    );
}

const SegmentMap: React.FC<SegmentMapProps> = ({
    totalSegments,
    receivedSegments,
    missingRequested = [],
    finalSegmentSeen = false,
}) => {
    const states = getSegmentStates(totalSegments, receivedSegments, missingRequested, finalSegmentSeen);

    return (
        <div>
            <div className="flex justify-end mb-2">
                <Legend />
            </div>
            <div className="flex flex-wrap gap-1.5 p-3 bg-[#1e1e1e] rounded-lg border border-[#333]">
                {states.map((state, i) => {
                    const { bg, border } = COLORS[state];
                    return (
                        <div
                            key={i}
                            className="flex items-center justify-center w-8 h-8 rounded-full text-[10px] font-mono text-white transition-colors duration-300"
                            style={{
                                background: bg,
                                border: `2px solid ${border}`,
                            }}
                            title={`Segment ${i}: ${COLORS[state].label}`}
                        >
                            {i}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

export default SegmentMap;
