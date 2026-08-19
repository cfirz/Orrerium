#!/usr/bin/env node
// Coding-agent hook emitter -> Orrerium /api/hook-event.
//
// SAFETY PROPERTY: this process must be INCAPABLE of exiting non-zero or
// hanging - a PreToolUse hook that exits 2 blocks the tool call, and a slow
// one drags every session on the machine. Every path below swallows errors,
// and a hard 1.5s cap forces exit 0 no matter what.
//
// Two delivery modes, no parsing in either - the server owns the dialects:
//   stdin (default)  - Claude Code and Gemini CLI hooks pipe the payload
//   argv JSON        - Codex `notify` passes the payload as one argument; when
//                      a non-flag argument is present stdin is never touched
//                      (Codex attaches nothing to it, so a read would hang)
// --source=<slug> tags the POST so the server picks the right adapter;
// without it the server assumes claude-code.
const PORT = process.env.ORRERIUM_PORT || 4321;

setTimeout(() => process.exit(0), 1500); // hard cap, deliberately not unref'd

const args = process.argv.slice(2);
const source = args.find((a) => a.startsWith('--source='))?.slice('--source='.length);
const argBody = args.find((a) => !a.startsWith('--'));

async function post(body) {
  try {
    const query = source ? `?source=${encodeURIComponent(source)}` : '';
    await fetch(`http://127.0.0.1:${PORT}/api/hook-event${query}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // BOM-strip: some shells (PowerShell pipes) prefix one
      body: body.replace(/^﻿/, ''),
      signal: AbortSignal.timeout(400),
    });
  } catch {
    // Orrerium down or slow - the session must never notice
  }
  process.exit(0);
}

if (argBody !== undefined) {
  post(argBody);
} else {
  const chunks = [];
  process.stdin.on('data', (c) => chunks.push(c));
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => post(Buffer.concat(chunks).toString('utf8')));
}
