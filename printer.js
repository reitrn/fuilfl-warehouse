let nodePrinter = null;

// Try to load the native printer module
try {
  nodePrinter = require('@thiagoelg/node-printer');
} catch (err) {
  console.warn('[Printer] Native printer module not available:', err.message);
}

// Cache USB port names so wmic only runs once per printer (saves ~1-2s per print)
const portNameCache = {};

/**
 * Get list of installed printers on this machine.
 * @returns {string[]}
 */
function getInstalledPrinters() {
  if (nodePrinter) {
    try {
      return nodePrinter.getPrinters().map((p) => p.name);
    } catch (err) {
      console.error('[Printer] Failed to list printers:', err.message);
    }
  }

  const { execSync } = require('child_process');

  // Fallback 1: wmic (fast, works on Windows 10 and earlier Windows 11 builds)
  try {
    const output = execSync(
      'wmic printer get name /format:list',
      { encoding: 'utf8', timeout: 10000 },
    );
    const names = output
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('Name='))
      .map((l) => l.replace('Name=', '').trim())
      .filter(Boolean);
    if (names.length > 0) return names;
    // wmic ran but returned nothing — fall through to PowerShell
  } catch (err) {
    console.warn('[Printer] wmic fallback failed, trying PowerShell:', err.message);
  }

  // Fallback 2: PowerShell Get-Printer (Windows 11 22H2+ where wmic is removed)
  try {
    const output = execSync(
      'powershell -NoProfile -NonInteractive -Command "Get-Printer | Select-Object -ExpandProperty Name"',
      { encoding: 'utf8', timeout: 15000 },
    );
    return output.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (err) {
    console.error('[Printer] PowerShell fallback failed:', err.message);
    return [];
  }
}

/**
 * Send raw print data (TSPL or ZPL) to a named printer.
 * @param {string} printerName
 * @param {string} data
 * @returns {Promise<void>}
 */
// ── FAST PATH (1.2.5, founder 4 Nov 2026: "it's taking too long to send to the printer") ────────────────────────────
// Before: every label went wmic → copy /b → a PowerShell script that compiled a .NET class on each print (2–4 s), because
// the native printer module is not in the build. Now: the printer's port is looked up ONCE (PowerShell Get-Printer, wmic as
// a fallback), remembered across restarts, and the raw bytes go straight to \\.\USBxxx (~50 ms) or to port 9100 for a
// network printer. The spooler routes are the last resort, not the route. printRaw resolves { via, ms } for the job log.
const fsx = require('fs');
const netx = require('net');
const { execFile: execFileX } = require('child_process');
let portStore = { get: () => ({}), set: () => {} };
/** main.js hands in the persistent store so a port survives a restart. */
function setPortStore(s) { portStore = s; }
const portMemo = {};
function psText(cmd, timeout = 8000) {
  return new Promise((resolve, reject) => execFileX('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', timeout, windowsHide: true },
    (err, out, errOut) => (err ? reject(new Error(String(errOut || err.message).trim())) : resolve(String(out || '').trim()))));
}
async function resolvePort(printerName, force = false) {
  if (!force) {
    if (portMemo[printerName]) return portMemo[printerName];
    const saved = (portStore.get() || {})[printerName];
    if (saved && saved.port) { portMemo[printerName] = saved; return saved; }
  }
  const esc = printerName.replace(/'/g, "''");
  let port = '';
  try { port = await psText(`(Get-Printer -Name '${esc}').PortName`); } catch (e) { console.warn('[Printer] Get-Printer:', e.message); }
  if (!port) {
    try {
      const out = await new Promise((res, rej) => execFileX('wmic', ['printer', 'where', `name='${printerName.replace(/"/g, '')}'`, 'get', 'PortName', '/format:list'], { encoding: 'utf8', timeout: 8000, windowsHide: true }, (e, o) => (e ? rej(e) : res(o))));
      const m = String(out).match(/PortName=(.+)/); if (m) port = m[1].trim();
    } catch (e) { console.warn('[Printer] wmic:', e.message); }
  }
  if (!port) throw new Error(`Could not find the port for "${printerName}"`);
  let host = null;
  if (!/^USB\d+$/i.test(port)) {
    try { const h = await psText(`(Get-PrinterPort -Name '${port.replace(/'/g, "''")}').PrinterHostAddress`); if (h && /^[\w.\-]+$/.test(h)) host = h; } catch { /* not a TCP port */ }
  }
  const info = { port, host, at: Date.now() };
  portMemo[printerName] = info;
  try { portStore.set({ ...(portStore.get() || {}), [printerName]: info }); } catch { /* memo is enough */ }
  console.log(`[Printer] Port for "${printerName}" = ${port}${host ? ` (${host}:9100)` : ''}`);
  return info;
}
function writeUsb(port, bytes) {
  return new Promise((resolve, reject) => {
    fsx.open(`\\\\.\\${port}`, 'w', (e, fd) => {
      if (e) return reject(e);
      fsx.write(fd, bytes, 0, bytes.length, null, (we, n) => { fsx.close(fd, () => {}); if (we) reject(we); else resolve(n); });
    });
  });
}
function writeTcp(host, bytes) {
  return new Promise((resolve, reject) => {
    const s = netx.connect(9100, host);
    const t = setTimeout(() => { s.destroy(); reject(new Error(`${host}:9100 timed out`)); }, 5000);
    s.once('connect', () => s.end(bytes));
    s.once('close', () => { clearTimeout(t); resolve(bytes.length); });
    s.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}
async function printDirect(printerName, bytes) {
  const attempt = async (i) => {
    if (/^USB\d+$/i.test(i.port)) { await writeUsb(i.port, bytes); return `usb ${i.port}`; }
    if (i.host) { await writeTcp(i.host, bytes); return `tcp ${i.host}`; }
    throw new Error(`port ${i.port} is not USB or network`);
  };
  try { return await attempt(await resolvePort(printerName)); }
  catch (e) {
    // a re-plugged printer can come back on another USB port — look it up again once before giving up on the fast path
    console.warn('[Printer] direct write failed, re-reading the port:', e.message);
    return attempt(await resolvePort(printerName, true));
  }
}
/** Look the ports up ahead of the first label (app start, printer chosen). */
async function warmPorts(names) {
  for (const n of (names || []).filter(Boolean)) { try { await resolvePort(n); } catch (e) { console.warn('[Printer] warm:', e.message); } }
}

/**
 * Send raw print data (TSPL or ZPL) to a named printer. Resolves { via, ms } — how it got there and how long it took.
 * @param {string} printerName
 * @param {string|Buffer} data
 */
async function printRaw(printerName, data) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const t0 = Date.now();
  const done = (via) => { const ms = Date.now() - t0; console.log(`[Printer] ${via} · ${bytes.length} bytes · ${ms} ms → "${printerName}"`); return { via, ms }; };
  if (nodePrinter) {
    await new Promise((resolve, reject) => nodePrinter.printDirect({ data: bytes, printer: printerName, type: 'RAW', success: () => resolve(), error: (err) => reject(new Error(String(err))) }));
    return done('native');
  }
  try { return done(await printDirect(printerName, bytes)); }
  catch (e) { console.warn('[Printer] fast path failed, falling back to the spooler:', e.message); }
  try { await printViaCopy(printerName, bytes); return done('copy'); }
  catch (e) { console.warn('[Printer] copy /b failed, trying WinSpool:', e.message); }
  await printViaPowerShell(printerName, bytes);
  return done('winspool');
}

/**
 * Look up the USB port name for a printer via wmic.
 * Result is cached so wmic only runs once per printer name.
 */
function getPortName(printerName) {
  if (portNameCache[printerName]) {
    return portNameCache[printerName];
  }
  const { execSync } = require('child_process');
  const escaped = printerName.replace(/"/g, '\\"');
  const out = execSync(
    `wmic printer where "name='${escaped}'" get PortName /format:list`,
    { encoding: 'utf8', timeout: 8000 },
  );
  const match = out.match(/PortName=(.+)/);
  if (!match) throw new Error('PortName not found in wmic output');
  const portName = match[1].trim();
  portNameCache[printerName] = portName;
  console.log(`[Printer] Port for "${printerName}" = ${portName} (cached)`);
  return portName;
}

/**
 * Bypass the Windows print spooler entirely: look up the printer's USB port name
 * (e.g. USB001) via wmic (cached), then write raw bytes directly to \\.\USB001.
 *
 * Tries pure Node.js fs.open first (fastest — no child process).
 * Falls back to PowerShell CreateFile P/Invoke if that fails.
 */
function printViaUsbPort(printerName, data) {
  return new Promise((resolve, reject) => {
    const fs   = require('fs');
    const os   = require('os');
    const path = require('path');

    let portName;
    try {
      portName = getPortName(printerName);
    } catch (err) {
      return reject(new Error(`Port lookup failed: ${err.message}`));
    }

    if (!portName.match(/^USB\d+$/i)) {
      return reject(new Error(`Port "${portName}" is not a USB port — skipping`));
    }

    const portPath = `\\\\.\\${portName}`;
    const bytes    = (Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8'));

    // ── Fast path: pure Node.js open + write (no child process, ~50ms) ──
    fs.open(portPath, 'w', (openErr, fd) => {
      if (!openErr) {
        fs.write(fd, bytes, 0, bytes.length, null, (writeErr, written) => {
          fs.close(fd, () => {});
          if (!writeErr) {
            console.log(`[Printer] Node.js direct write OK: ${written} bytes to ${portPath}`);
            return resolve();
          }
          console.warn(`[Printer] Node.js write failed (${writeErr.message}), trying PowerShell`);
          printViaUsbPowerShell(portPath, bytes, resolve, reject);
        });
      } else {
        console.warn(`[Printer] Node.js open failed (${openErr.message}), trying PowerShell`);
        printViaUsbPowerShell(portPath, bytes, resolve, reject);
      }
    });
  });
}

/**
 * PowerShell fallback for USB write using Win32 CreateFile P/Invoke.
 * Only used if the direct Node.js write fails.
 */
function printViaUsbPowerShell(portPath, bytes, resolve, reject) {
  const fs   = require('fs');
  const os   = require('os');
  const path = require('path');

  const ts       = Date.now();
  const dataFile = path.join(os.tmpdir(), `reitrn_${ts}.prn`);
  const psFile   = path.join(os.tmpdir(), `reitrn_usb_${ts}.ps1`);

  fs.writeFileSync(dataFile, bytes);

  const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class NativeUsb {
  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Auto)]
  public static extern IntPtr CreateFile(string lpFileName, uint dwAccess, uint dwShare, IntPtr lpSA, uint dwCreation, uint dwFlags, IntPtr hTemplate);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool WriteFile(IntPtr hFile, byte[] lpBuffer, int nBytesToWrite, out int lpBytesWritten, IntPtr lpOverlapped);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr hObject);
}
"@
$GENERIC_WRITE   = 0x40000000
$FILE_SHARE_READ = 0x1
$OPEN_EXISTING   = 3
$INVALID_HANDLE  = [IntPtr](-1)
$handle = [NativeUsb]::CreateFile('${portPath}', $GENERIC_WRITE, $FILE_SHARE_READ, [IntPtr]::Zero, $OPEN_EXISTING, 0, [IntPtr]::Zero)
if ($handle -eq $INVALID_HANDLE -or $handle -eq [IntPtr]::Zero) {
  $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  Write-Error "CreateFile failed, Win32 error $err"
  exit 1
}
$bytes   = [System.IO.File]::ReadAllBytes('${dataFile}')
$written = 0
$ok      = [NativeUsb]::WriteFile($handle, $bytes, $bytes.Length, [ref]$written, [IntPtr]::Zero)
[NativeUsb]::CloseHandle($handle) | Out-Null
if (-not $ok) {
  $err = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  Write-Error "WriteFile failed, Win32 error $err"
  exit 1
}
Write-Host "USB write OK: $written bytes to '${portPath}'"
`;
  fs.writeFileSync(psFile, Buffer.from('﻿' + script, 'utf16le'));

  const { execFile } = require('child_process');
  execFile(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile],
    { timeout: 15000 },
    (err, stdout, stderr) => {
      try { fs.unlinkSync(dataFile); } catch {}
      try { fs.unlinkSync(psFile);   } catch {}
      if (stdout) console.log('[Printer] PS stdout:', stdout.trim());
      if (stderr) console.warn('[Printer] PS stderr:', stderr.trim());
      if (err || stderr?.trim()) reject(new Error(stderr || err?.message || 'USB write failed'));
      else resolve();
    },
  );
}

/**
 * Simplest raw print: write data to a temp file, then `copy /b file \\localhost\PrinterName`.
 * Works for any Windows printer that accepts raw data. No P/Invoke needed.
 */
function printViaCopy(printerName, data) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    const fs   = require('fs');
    const os   = require('os');
    const path = require('path');

    const dataFile = path.join(os.tmpdir(), `reitrn_${Date.now()}.prn`);
    fs.writeFileSync(dataFile, (Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')));

    const dest = `\\\\localhost\\${printerName}`;
    console.log(`[Printer] copy /b "${dataFile}" "${dest}"`);

    execFile('cmd', ['/c', 'copy', '/b', dataFile, dest], { timeout: 15000 }, (err, stdout, stderr) => {
      try { fs.unlinkSync(dataFile); } catch {}
      if (stdout) console.log('[Printer] copy stdout:', stdout.trim());
      if (stderr) console.warn('[Printer] copy stderr:', stderr.trim());
      if (err) {
        console.error('[Printer] copy /b failed:', err.message);
        reject(err);
      } else {
        console.log(`[Printer] copy /b succeeded for "${printerName}"`);
        resolve();
      }
    });
  });
}

/**
 * PowerShell raw printing via WinSpool P/Invoke.
 * Writes the PS script to a temp file to avoid inline command length/escaping issues.
 */
function printViaPowerShell(printerName, data) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    const fs   = require('fs');
    const os   = require('os');
    const path = require('path');

    const ts       = Date.now();
    const dataFile = path.join(os.tmpdir(), `reitrn_${ts}.prn`);
    const psFile   = path.join(os.tmpdir(), `reitrn_${ts}.ps1`);

    fs.writeFileSync(dataFile, (Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8')));

    // No backslash escaping - PowerShell single-quoted strings treat \ as literal
    const printerEscaped = printerName.replace(/'/g, "''");

    const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinSpool {
  [DllImport("winspool.drv", CharSet=CharSet.Unicode)] public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv")] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet=CharSet.Unicode)] public static extern int StartDocPrinter(IntPtr h, int lv, ref DOCINFO di);
  [DllImport("winspool.drv")] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv")] public static extern bool WritePrinter(IntPtr h, IntPtr buf, int len, out int written);
  [DllImport("winspool.drv")] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv")] public static extern bool EndDocPrinter(IntPtr h);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
}
"@
$h = [IntPtr]::Zero
$opened = [WinSpool]::OpenPrinter('${printerEscaped}', [ref]$h, [IntPtr]::Zero)
if (-not $opened -or $h -eq [IntPtr]::Zero) {
  Write-Error "OpenPrinter failed for '${printerEscaped}' - check printer name matches exactly"
  exit 1
}
Write-Host "OpenPrinter OK, handle=$h"
$di = New-Object WinSpool+DOCINFO
$di.pDocName  = 'reitrn'
$di.pDataType = 'RAW'
$jobId = [WinSpool]::StartDocPrinter($h, 1, [ref]$di)
if ($jobId -le 0) { Write-Error "StartDocPrinter failed"; [WinSpool]::ClosePrinter($h); exit 1 }
Write-Host "StartDocPrinter OK, jobId=$jobId"
[WinSpool]::StartPagePrinter($h) | Out-Null
$bytes = [System.IO.File]::ReadAllBytes('${dataFile}')
Write-Host "Sending $($bytes.Length) bytes to printer"
$ptr = [Runtime.InteropServices.Marshal]::AllocHGlobal($bytes.Length)
[Runtime.InteropServices.Marshal]::Copy($bytes, 0, $ptr, $bytes.Length)
$w = 0
$wrote = [WinSpool]::WritePrinter($h, $ptr, $bytes.Length, [ref]$w)
[Runtime.InteropServices.Marshal]::FreeHGlobal($ptr)
Write-Host "WritePrinter result=$wrote, bytesWritten=$w"
[WinSpool]::EndPagePrinter($h) | Out-Null
[WinSpool]::EndDocPrinter($h) | Out-Null
[WinSpool]::ClosePrinter($h) | Out-Null
Write-Host "Done"
`;

    // Write as UTF-16 LE with BOM — PowerShell 5.1 reads this natively without encoding issues
    fs.writeFileSync(psFile, Buffer.from('﻿' + script, 'utf16le'));

    execFile(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile],
      { timeout: 30000 },
      (err, stdout, stderr) => {
        // Always log PS output so we can see exactly what happened
        if (stdout) console.log('[Printer] PS stdout:', stdout.trim());
        if (stderr) console.warn('[Printer] PS stderr:', stderr.trim());
        try { fs.unlinkSync(dataFile); } catch {}
        try { fs.unlinkSync(psFile);   } catch {}
        if (err) reject(new Error(stderr || err.message));
        else resolve();
      },
    );
  });
}

/**
 * Generate a simple test label in TSPL format (4x6 inch label).
 * Works with most thermal printers (TSC, Zebra, etc.)
 */
/**
 * Printer command language, inferred from the Windows printer name.
 *
 * Zebra speaks ZPL, TSC speaks TSPL, and feeding one the other's commands
 * produces NOTHING — no error, no label, no clue. The old test label was
 * always TSPL (carried over from the Lite agent, which only ever drove TSC
 * printers), so pressing Test print on a Zebra silently did nothing and looked
 * like a broken app or a broken printer. It cost an afternoon on 2026-09-19
 * while the real print path was working perfectly.
 *
 * Real jobs are unaffected — those arrive with the language already chosen by
 * the warehouse UI. This is only for the self-test.
 */
function detectPrinterLanguage(printerName) {
  const n = String(printerName || '').toLowerCase();
  if (/\btsc\b|\bda\d{3}\b|\bttp\b|\btdp\b/.test(n)) return 'tspl';
  if (/zebra|zdesigner|\bzpl\b|\bg[kx]\d{3}|\bzd\d|\bzt\d/.test(n)) return 'zpl';
  return 'zpl'; // most label printers here are Zebra; a wrong guess prints nothing, never garbage
}

function generateTestLabel(printerName) {
  const name = String(printerName || '').slice(0, 34);
  if (detectPrinterLanguage(printerName) === 'zpl') {
    return [
      '^XA',
      '^CI28',
      `^FO30,30^A0N,32,32^FD${require('./brand').name}^FS`,
      '^FO30,74^A0N,24,24^FDTest label^FS',
      '^FO30,108^A0N,20,20^FD' + name + '^FS',
      '^FO30,140^BY2^BCN,70,Y,N,N^FDTEST-OK^FS',
      '^XZ',
      '',
    ].join('\n');
  }
  return [
    'SIZE 4 x 6',
    'DENSITY 8',
    'REFERENCE 0,0',
    'DIRECTION 0',
    'CLS',
    `TEXT 50,100,"2",0,1,1,"${require('./brand').name}"`,
    'TEXT 50,150,"1",0,1,1,"Test label"',
    'TEXT 50,200,"0",0,1,1,"' + name + '"',
    'BARCODE 50,240,"128",60,1,0,2,2,"TEST-OK"',
    'PRINT 1',
    '',
  ].join('\n');
}

module.exports = { getInstalledPrinters, printRaw, generateTestLabel, detectPrinterLanguage, getPortNameForPrinter: getPortName, setPortStore, warmPorts, resolvePort };
