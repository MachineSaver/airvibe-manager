"use client";

import React, { createContext, useContext, useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';

interface SocketContextType {
    socket: Socket | null;
    connected: boolean;
    messages: any[];
}

const SocketContext = createContext<SocketContextType>({
    socket: null,
    connected: false,
    messages: []
});

export const useSocket = () => useContext(SocketContext);

export const SocketProvider = ({ children }: { children: React.ReactNode }) => {
    const [socket, setSocket] = useState<Socket | null>(null);
    const [connected, setConnected] = useState(false);
    const [messages, setMessages] = useState<any[]>([]);

    useEffect(() => {
        const socketUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';
        const newSocket = io(socketUrl);

        newSocket.on('connect', () => {
            console.log('Connected to backend');
            setConnected(true);
        });

        newSocket.on('disconnect', () => {
            console.log('Disconnected from backend');
            setConnected(false);
        });

        newSocket.on('mqtt:message', (message) => {
            setMessages((prev) => [message, ...prev].slice(0, 500)); // Keep last 500
        });

        setSocket(newSocket);

        return () => {
            newSocket.close();
        };
    }, []);

    return (
        <SocketContext.Provider value={{ socket, connected, messages }}>
            {children}
        </SocketContext.Provider>
    );
};
