import React from 'react';

interface SegmentMapProps {
    totalSegments: number;
    receivedSegments: number[]; // Array of indices
    missingRequested?: number[]; // Indices that have been requested via downlink
}

const SegmentMap: React.FC<SegmentMapProps> = ({ totalSegments, receivedSegments, missingRequested = [] }) => {
    const receivedSet = new Set(receivedSegments);
    const requestedSet = new Set(missingRequested);

    // Helper to determine color
    const getColor = (index: number) => {
        if (receivedSet.has(index)) return 'bg-emerald-500 border-emerald-600'; // Green
        if (requestedSet.has(index)) return 'bg-yellow-500 border-yellow-600'; // Yellow
        return 'bg-slate-800 border-slate-700'; // Grey (Pending/Missing but not requested yet?)
        // Actually, if it's missing and we are past the end, it should be Red?
        // For now, let's stick to simple: Green = Received, Grey = Empty.
        // If we want Red, we need to know the "max seen" index.
    };

    // Let's render a grid
    return (
        <div className="grid grid-cols-12 gap-1 p-2 bg-slate-900 rounded-lg border border-slate-800">
            {Array.from({ length: totalSegments }).map((_, i) => (
                <div
                    key={i}
                    className={`w-6 h-6 rounded-full border ${getColor(i)} flex items-center justify-center text-[10px] text-white font-mono transition-colors duration-300`}
                    title={`Segment ${i}`}
                >
                    {i}
                </div>
            ))}
        </div>
    );
};

export default SegmentMap;
