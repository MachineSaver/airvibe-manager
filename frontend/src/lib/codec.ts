import { encodeDownlink as rawEncode, decodeDownlink as rawDecode } from './airvibeCodec.js';

export interface EncodeResult {
  fPort: number | null;
  bytes: number[];
  errors: string[];
  warnings: string[];
}

export interface DecodeResult {
  data: Record<string, unknown>;
  errors: string[];
  warnings: string[];
}

export function encodeDownlink(input: { fPort: number; data: Record<string, unknown> }): EncodeResult {
  return rawEncode(input) as EncodeResult;
}

export function decodeDownlink(input: { fPort: number; bytes: number[] }): DecodeResult {
  return rawDecode(input) as DecodeResult;
}

export function bytesToHex(bytes: number[]): string {
  return bytes.map(b => (b & 0xFF).toString(16).padStart(2, '0')).join('').toUpperCase();
}
