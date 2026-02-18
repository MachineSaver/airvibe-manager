import React, { useEffect, useMemo, useRef, useState } from "react";

// AirVibe FUOTA Helper v1.3 (clipboard-safe, BE commands, port labels, key formatting, uplink docs)
// - Initialize command = 2-byte BE (0x0005) + 4-byte BE size
// - Verify command = 2-byte BE (0x0006)
// - Downlink commands → Port 22
// - Data blocks → Port 25
// - Block keys are 2-byte big-endian hex strings (e.g., 0 → "0000", 256 → "0100")
// - Data Verification Status Uplink (Packet Type 0x11) table & guidance
// - Robust clipboard copy with graceful failure toast (no manual copy UI)
// - Self tests: endianness, chunking, JSON mapping, command payloads, key formatting, uplink parser

// ----------------------------- Utility ---------------------------------
function bytesToHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes[i].toString(16).padStart(2, "0");
    out += h;
  }
  return out;
}

function hexPrefixed(bytes) {
  return "0x" + bytesToHex(bytes);
}

function u32ToBytesBE(n) {
  return new Uint8Array([
    (n >>> 24) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 8) & 0xff,
    n & 0xff,
  ]);
}

function u32ToBytesLE(n) {
  return new Uint8Array([
    n & 0xff,
    (n >>> 8) & 0xff,
    (n >>> 16) & 0xff,
    (n >>> 24) & 0xff,
  ]);
}

function download(filename, text) {
  try {
    const blob = new Blob([text], { type: "application/json;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return true;
  } catch (e) {
    console.error("Download failed:", e);
    return false;
  }
}

// Attempt to copy text robustly. Return true on success, false on failure.
async function safeCopy(text) {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* fall back */ }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return !!ok;
  } catch (_) {
    return false;
  }
}

function chunkBytes(arr, chunkSize) {
  const out = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    out.push(arr.slice(i, Math.min(i + chunkSize, arr.length)));
  }
  return out;
}

function formatBlockKeyBE(index) {
  // 2-byte big-endian hex label (lowercase), e.g., 0 -> "0000", 256 -> "0100"
  const v = index & 0xffff;
  return v.toString(16).padStart(4, "0");
}

function makeInitPayloadBE(size) {
  // 0x0005 + 4-byte BE size
  const cmd = new Uint8Array([0x00, 0x05]);
  const param = u32ToBytesBE(size >>> 0);
  const payload = new Uint8Array(2 + 4);
  payload.set(cmd, 0);
  payload.set(param, 2);
  return hexPrefixed(payload);
}

function makeVerifyPayload() {
  // 0x0006
  return "0x0006";
}

// Parse Data Verification Status Uplink payload (Packet Type 0x11)
// Returns { ok: boolean, type, missedFlag, count, blocks (array of numbers 0..65535 BE) }
function parseDataVerificationUplink(bytes) {
  if (!bytes || bytes.length < 3) return { ok: false, reason: "too_short" };
  const type = bytes[0];
  if (type !== 0x11) return { ok: false, reason: "wrong_type", type };
  const missedFlag = bytes[1];
  const count = bytes[2];
  const needed = 3 + count * 2;
  if (bytes.length < needed) return { ok: false, reason: "incomplete", count };
  const blocks = [];
  for (let i = 0; i < count; i++) {
    const hi = bytes[3 + i * 2];
    const lo = bytes[3 + i * 2 + 1];
    blocks.push(((hi << 8) | lo) & 0xffff);
  }
  return { ok: true, type, missedFlag, count, blocks };
}

// ----------------------------- Component ---------------------------------
export default function AirVibeFUOTAHelper() {
  const fileInputRef = useRef(null);

  const [file, setFile] = useState(null);
  const [bytes, setBytes] = useState(null);
  const [err, setErr] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [copyToast, setCopyToast] = useState("");

  // --- Derived values ---
  const size = bytes?.length ?? 0;
  const chunkSize = 51;
  const chunkCount = useMemo(() => (size ? Math.ceil(size / chunkSize) : 0), [size]);

  const sizeBytesBE = useMemo(
    () => (size ? u32ToBytesBE(size >>> 0) : new Uint8Array([0, 0, 0, 0])),
    [size]
  );

  const initCmdPayload = useMemo(() => makeInitPayloadBE(size >>> 0), [size]);
  const verifyCmdPayload = useMemo(() => makeVerifyPayload(), []);

  const jsonObject = useMemo(() => {
    if (!bytes) return null;
    const obj = {};
    for (let i = 0; i < chunkCount; i++) {
      const start = i * chunkSize;
      const end = Math.min(start + chunkSize, bytes.length);
      const segment = bytes.slice(start, end);
      const key = formatBlockKeyBE(i);
      obj[key] = "0x" + bytesToHex(segment);
    }
    return obj;
  }, [bytes, chunkCount]);

  function reset() {
    setFile(null);
    setBytes(null);
    setErr("");
    setShowAll(false);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  async function handleFile(f) {
    try {
      setErr("");
      const buf = await f.arrayBuffer();
      const view = new Uint8Array(buf);
      if (view.length > 0xffffffff) {
        setErr("Upgrade image size exceeds 32-bit limit.");
        return;
      }
      setFile(f);
      setBytes(view);
    } catch (e) {
      console.error(e);
      setErr("Failed to read file.");
    }
  }

  function handleDownloadJSON() {
    if (!jsonObject) return;
    const pretty = JSON.stringify(jsonObject, null, 2);
    const outName = (file?.name?.replace(/\.[^/.]+$/, "") || "upgrade") + ".fuota.blocks.json";
    const ok = download(outName, pretty);
    setCopyToast(ok ? `Downloaded ${outName}` : "Download failed by browser policy");
    setTimeout(() => setCopyToast(""), 2000);
  }

  async function handleCopy(text, label) {
    const ok = await safeCopy(text);
    setCopyToast(ok ? `${label || "Text"} copied to clipboard.` : "Copy blocked by environment. Use Ctrl/Cmd+C.");
    setTimeout(() => setCopyToast(""), 2200);
  }

  // ----------------------------- Self Tests ---------------------------------
  function runSelfTests() {
    const results = [];

    // t1: u32 endianness conversion for 0x01020304
    const val = 0x01020304;
    const be = bytesToHex(u32ToBytesBE(val));
    const le = bytesToHex(u32ToBytesLE(val));
    results.push({ name: "u32ToBytesBE(0x01020304)", pass: be === "01020304", got: be, expect: "01020304" });
    results.push({ name: "u32ToBytesLE(0x01020304)", pass: le === "04030201", got: le, expect: "04030201" });

    // t2: chunking sizes
    const arr0 = new Uint8Array(0);
    const arr51 = new Uint8Array(51).fill(0xaa);
    const arr52 = new Uint8Array(52).fill(0xbb);
    const arr103 = new Uint8Array(103).fill(0xcc);

    const ch0 = chunkBytes(arr0, 51);
    const ch51 = chunkBytes(arr51, 51);
    const ch52 = chunkBytes(arr52, 51);
    const ch103 = chunkBytes(arr103, 51);

    results.push({ name: "chunk 0 bytes", pass: ch0.length === 0, got: ch0.length, expect: 0 });
    results.push({ name: "chunk 51 bytes", pass: ch51.length === 1 && ch51[0].length === 51, got: `${ch51.length}/${ch51[0]?.length}`, expect: "1/51" });
    results.push({ name: "chunk 52 bytes", pass: ch52.length === 2 && ch52[0].length === 51 && ch52[1].length === 1, got: `${ch52.length}/${ch52[0]?.length}+${ch52[1]?.length}`, expect: "2/51+1" });
    results.push({ name: "chunk 103 bytes", pass: ch103.length === 3 && ch103[0].length === 51 && ch103[1].length === 51 && ch103[2].length === 1, got: `${ch103.length}/${ch103[0]?.length}+${ch103[1]?.length}+${ch103[2]?.length}`, expect: "3/51+51+1" });

    // t3: key formatting
    results.push({ name: "formatBlockKeyBE(0)", pass: formatBlockKeyBE(0) === "0000", got: formatBlockKeyBE(0), expect: "0000" });
    results.push({ name: "formatBlockKeyBE(256)", pass: formatBlockKeyBE(256) === "0100", got: formatBlockKeyBE(256), expect: "0100" });

    // t4: command payloads
    const init33 = makeInitPayloadBE(0x33);
    results.push({ name: "makeInitPayloadBE(0x33)", pass: init33 === "0x000500000033", got: init33, expect: "0x000500000033" });
    const ver = makeVerifyPayload();
    results.push({ name: "makeVerifyPayload()", pass: ver === "0x0006", got: ver, expect: "0x0006" });

    // t5: JSON mapping value format
    const segs = chunkBytes(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), 51);
    const mapTest = {};
    for (let i = 0; i < segs.length; i++) mapTest[formatBlockKeyBE(i)] = "0x" + bytesToHex(segs[i]);
    const firstKey = Object.keys(mapTest)[0];
    const firstVal = mapTest[firstKey];
    results.push({ name: "json first key is 0000", pass: firstKey === "0000", got: firstKey, expect: "0000" });
    results.push({ name: "json first value hex prefixed", pass: /^0x[0-9a-f]*$/.test(firstVal), got: firstVal, expect: "0xdeadbeef" });

    // t6: parse Data Verification Status Uplink
    const okPayload = new Uint8Array([0x11, 0x00, 0x00]);
    const parsedOK = parseDataVerificationUplink(okPayload);
    results.push({ name: "uplink OK type", pass: parsedOK.ok && parsedOK.type === 0x11, got: parsedOK.type, expect: 0x11 });
    results.push({ name: "uplink OK count=0", pass: parsedOK.count === 0 && parsedOK.blocks.length === 0, got: `${parsedOK.count}/${parsedOK.blocks.length}`, expect: "0/0" });

    const missPayload = new Uint8Array([0x11, 0x01, 0x02, 0x01, 0x00, 0x00, 0x0a]); // flag=1, count=2, blocks 0x0100, 0x000a
    const parsedMiss = parseDataVerificationUplink(missPayload);
    const condMiss = parsedMiss.ok && parsedMiss.missedFlag === 1 && parsedMiss.count === 2 && parsedMiss.blocks[0] === 256 && parsedMiss.blocks[1] === 10;
    results.push({ name: "uplink miss parse", pass: condMiss, got: JSON.stringify(parsedMiss), expect: '{"missedFlag":1,"count":2,"blocks":[256,10]}' });

    return results;
  }

  const selfTestResults = useMemo(runSelfTests, []);
  const allPass = selfTestResults.every((t) => t.pass);

  // ----------------------------- Render ---------------------------------
  const steps = [
    "Send Command Downlink 0x0005 (Initialize Upgrade Session) + 4-byte size (Big-Endian) to Port 22.",
    "Device switches to LoRaWAN Class C and acknowledges; gateway also goes Class C.",
    "Send Upgrade Data Downlinks to Port 25, 51 bytes per block (last may be shorter), blocks numbered 0..N-1.",
    "After all data is sent, send Command Downlink 0x0006 (Verify) to Port 22.",
    "If the device responds with a list of missed blocks (up to 25), resend those blocks to Port 25, then send 0x0006 again to Port 22.",
    "Repeat until the device reports 0 missed blocks; it will then CRC-check and begin applying the update.",
    "Upon completion, the device returns to Class A and sends an Upgrade Status packet; gateway returns to Class A as well.",
  ];

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6">
      <div className="max-w-5xl mx-auto">
        <header className="mb-6">
          <h1 className="text-3xl font-bold tracking-tight">AirVibe FUOTA Helper</h1>
          <p className="text-slate-300 mt-2">
            Select your <code>upgrade.bin</code>, see the size and initialization payload, and generate 51-byte FUOTA data blocks as JSON.
          </p>
          {copyToast && (
            <div className="mt-3 rounded-xl bg-emerald-900/40 border border-emerald-700 px-3 py-2 text-sm">
              {copyToast}
            </div>
          )}
        </header>

        <section className="mb-6 grid gap-4">
          <div className="rounded-2xl border border-slate-800 p-4">
            <div className="flex items-center gap-3">
              <input
                ref={fileInputRef}
                type="file"
                accept=".bin,application/octet-stream"
                className="block w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-sm file:font-semibold file:bg-indigo-600 file:text-white hover:file:bg-indigo-500"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleFile(f);
                }}
              />
              {file && (
                <button
                  className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-sm"
                  onClick={reset}
                >Reset</button>
              )}
            </div>
            {err && <p className="text-red-400 mt-3">{err}</p>}
            {file && (
              <div className="mt-4 text-sm grid sm:grid-cols-2 gap-4">
                <div>
                  <div className="text-slate-400">Selected file</div>
                  <div className="font-mono break-all">{file.name}</div>
                </div>
                <div>
                  <div className="text-slate-400">Size (bytes)</div>
                  <div className="font-mono">{size.toLocaleString()}</div>
                </div>
                <div>
                  <div className="text-slate-400">Chunk size</div>
                  <div className="font-mono">51 bytes</div>
                </div>
                <div>
                  <div className="text-slate-400">Total blocks</div>
                  <div className="font-mono">{chunkCount.toLocaleString()}</div>
                </div>
              </div>
            )}
          </div>

          {/* Initialize + Verify commands (Port 22) */}
          <div className="rounded-2xl border border-slate-800 p-4">
            <h2 className="text-xl font-semibold">Downlink Commands (Port 22)</h2>
            <p className="text-slate-300 mt-1 text-sm">
              Initialization uses <span className="font-mono">0x0005</span> plus a 4-byte Big-Endian size parameter. Verification uses <span className="font-mono">0x0006</span>.
            </p>
            <div className="mt-4 grid sm:grid-cols-2 gap-4">
              <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
                <div className="font-semibold">Initialize (0x0005 + size BE)</div>
                <div className="mt-2 text-xs text-slate-400">Size param (BE) bytes:</div>
                <div className="mt-1 font-mono text-sm break-all">{hexPrefixed(sizeBytesBE)}</div>
                <div className="mt-2 text-xs text-slate-400">Downlink payload example (Port 22):</div>
                <div className="mt-1 font-mono text-sm break-all">{initCmdPayload}</div>
                <div className="mt-3">
                  <button
                    className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-sm disabled:opacity-50"
                    onClick={() => handleCopy(initCmdPayload, "Init payload")}
                    disabled={!file}
                  >Copy init payload</button>
                </div>
              </div>
              <div className="rounded-xl bg-slate-900 border border-slate-800 p-4">
                <div className="font-semibold">Verify (0x0006)</div>
                <div className="mt-2 text-xs text-slate-400">Send after all blocks have been delivered (Port 22). Repeat after resending any missed blocks.</div>
                <div className="mt-2 font-mono text-sm break-all">{verifyCmdPayload}</div>
                <div className="mt-3">
                  <button
                    className="px-3 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-sm"
                    onClick={() => handleCopy(verifyCmdPayload, "Verify payload")}
                  >Copy verify payload</button>
                </div>
              </div>
            </div>
          </div>

          {/* Blocks preview + download (Port 25) */}
          <div className="rounded-2xl border border-slate-800 p-4">
            <h2 className="text-xl font-semibold">Generated Data Blocks (Port 25, 51 bytes each)</h2>
            <p className="text-slate-300 mt-1 text-sm">
              JSON maps each <strong>2-byte BE block number</strong> (e.g., <span className="font-mono">"0000"</span>, <span className="font-mono">"0100"</span>) to a hex string of the data bytes (prefixed with <span className="font-mono">0x</span>). The last block may be shorter.
            </p>

            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className="px-3 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-sm disabled:opacity-50"
                onClick={handleDownloadJSON}
                disabled={!jsonObject}
              >Download JSON</button>
              <button
                className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-sm disabled:opacity-50"
                onClick={() => jsonObject && handleCopy(JSON.stringify(jsonObject, null, 2), "Blocks JSON")}
                disabled={!jsonObject}
              >Copy JSON</button>
              <button
                className="px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-sm disabled:opacity-50"
                onClick={() => setShowAll((v) => !v)}
                disabled={!jsonObject}
              >{showAll ? "Collapse preview" : "Show full preview"}</button>
            </div>

            {jsonObject && (
              <div className="mt-4 max-h-96 overflow-auto rounded-xl bg-slate-900 border border-slate-800 p-3">
                <pre className="text-xs leading-relaxed">
{(() => {
  const entries = Object.entries(jsonObject);
  const maxPreview = showAll ? entries.length : Math.min(50, entries.length);
  const previewObj = Object.fromEntries(entries.slice(0, maxPreview));
  const extra = entries.length - maxPreview;
  return JSON.stringify(previewObj, null, 2) + (extra > 0 ? `\n... (${extra} more blocks not shown)` : "");
})()}
                </pre>
              </div>
            )}

            {!jsonObject && (
              <p className="text-slate-400 text-sm mt-2">Pick an <code>.bin</code> to generate blocks.</p>
            )}
          </div>

          {/* Data Verification Status Uplink docs */}
          <div className="rounded-2xl border border-slate-800 p-4">
            <h2 className="text-xl font-semibold">Data Verification Status Uplink (AirVibe → Gateway)</h2>
            <p className="text-slate-300 mt-1 text-sm">Structure of the uplink payload reported by the device after verification runs:</p>
            <div className="mt-3 overflow-auto">
              <table className="w-full text-sm border border-slate-800">
                <thead className="bg-slate-900">
                  <tr>
                    <th className="text-left p-2 border-b border-slate-800">Byte #</th>
                    <th className="text-left p-2 border-b border-slate-800">Field Name</th>
                    <th className="text-left p-2 border-b border-slate-800">Description</th>
                  </tr>
                </thead>
                <tbody>
                  <tr><td className="p-2">0</td><td className="p-2">Packet Type</td><td className="p-2">17 (0x11)</td></tr>
                  <tr><td className="p-2">1</td><td className="p-2">Missed data flag</td><td className="p-2">0 = all data received, 1 = some data is missed</td></tr>
                  <tr><td className="p-2">2</td><td className="p-2">Number of missed blocks</td><td className="p-2">Count of missed block numbers included in this packet (0..25)</td></tr>
                  <tr><td className="p-2">3,4</td><td className="p-2">Missed block number 1</td><td className="p-2">16-bit block number, Big Endian</td></tr>
                  <tr><td className="p-2">5,6</td><td className="p-2">Missed block number 2</td><td className="p-2">16-bit block number, Big Endian</td></tr>
                  <tr><td className="p-2">…</td><td className="p-2">…</td><td className="p-2">…</td></tr>
                  <tr><td className="p-2">51,52</td><td className="p-2">Missed block number 25</td><td className="p-2">16-bit block number, Big Endian</td></tr>
                </tbody>
              </table>
            </div>
            <div className="mt-3 text-sm text-slate-300 space-y-2">
              <p>Examples:</p>
              <ul className="list-disc list-inside">
                <li>All data received → 3 bytes: <span className="font-mono">0x11 0x00 0x00</span></li>
                <li>Missing data present → <span className="font-mono">0x11 0x01 &lt;N&gt; &lt;b1_hi&gt; &lt;b1_lo&gt; … &lt;bN_hi&gt; &lt;bN_lo&gt;</span> (each block number is 16-bit BE)</li>
                <li>If more than 25 blocks are missing, only the first 25 are listed. Resend those, then verify again to receive the next set.</li>
              </ul>
              <p className="pt-1">Workflow:</p>
              <ol className="list-decimal list-inside space-y-1">
                <li>Send <span className="font-mono">0x0006</span> (Verify) to Port 22.</li>
                <li>If the uplink reports missed blocks, resend those specific block numbers to Port 25.</li>
                <li>Send <span className="font-mono">0x0006</span> again; repeat until the uplink shows flag=0 and count=0.</li>
                <li>Upon a zero-missed uplink, the device starts CRC16 check and upgrade procedure.</li>
              </ol>
            </div>
          </div>

          {/* Self Tests */}
          <div className="rounded-2xl border border-slate-800 p-4">
            <h2 className="text-xl font-semibold">Self‑Tests</h2>
            <p className="text-slate-300 mt-1 text-sm">Quick checks to ensure the core logic behaves correctly in this environment.</p>
            <div className={`mt-3 rounded-xl p-3 text-sm ${allPass ? "bg-emerald-900/30 border border-emerald-700" : "bg-amber-900/30 border border-amber-700"}`}>
              <div className="font-mono">Overall: {allPass ? "PASS" : "CHECK FAILURES"}</div>
              <ul className="mt-2 space-y-1">
                {selfTestResults.map((t, i) => (
                  <li key={i} className="grid grid-cols-3 gap-2 items-start">
                    <span className={`text-xs ${t.pass ? "text-emerald-400" : "text-amber-300"}`}>{t.pass ? "PASS" : "FAIL"}</span>
                    <span className="text-xs font-mono break-all col-span-2">{t.name} — got: {t.got} expect: {t.expect}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Notes */}
          <div className="rounded-2xl border border-slate-800 p-4">
            <h2 className="text-xl font-semibold">Notes & Assumptions</h2>
            <ul className="mt-2 text-sm text-slate-300 space-y-1 list-disc list-inside">
              <li>Downlink commands (Initialize/Verify) are sent to <strong>Port 22</strong>.</li>
              <li>Data block downlinks are sent to <strong>Port 25</strong>.</li>
              <li>Block payloads contain only your binary data bytes. The JSON keys ("0000", "0001", ...) represent the block numbers in 2-byte BE hex.</li>
              <li>The 32-bit size parameter for Initialize is Big-Endian.</li>
              <li>Each block is exactly 51 bytes except the final block when the file size is not divisible by 51.</li>
              <li>All processing happens in your browser — the file is not uploaded.</li>
            </ul>
          </div>
        </section>

        <footer className="mt-6 text-center text-xs text-slate-500">
          Built for AirVibe integrator training • FUOTA segmenter v1.3 (BE cmds, ports 22/25, uplink docs)
        </footer>
      </div>
    </div>
  );
}
