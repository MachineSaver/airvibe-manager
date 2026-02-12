"use client";

import MQTTMessageCard from './MQTTMessageCard';

interface MQTTMonitorProps {
  messages: { topic: string; payload: string; timestamp: string }[];
}

export default function MQTTMonitor({ messages }: MQTTMonitorProps) {
  return (
    <div className="overflow-auto p-4 space-y-2">
      {messages.length === 0 && (
        <div className="text-gray-500 text-center mt-10">No messages received yet.</div>
      )}
      {messages.map((msg, idx) => (
        <MQTTMessageCard
          key={idx}
          topic={msg.topic}
          payload={msg.payload}
          timestamp={msg.timestamp}
        />
      ))}
    </div>
  );
}
