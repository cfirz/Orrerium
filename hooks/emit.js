#!/usr/bin/env node
// Claude Code hook emitter -> Orrerium /api/hook-event.
//
// SAFETY PROPERTY: this process must be INCAPABLE of exiting non-zero or
// hanging - a PreToolUse hook that exits 2 blocks the tool call, and a slow
// one drags every session on the machine. Every path below swallows errors,
// and a hard 1.5s cap forces exit 0 no matter what.
//
// Wire it in ~/.claude/settings.json hooks with a small timeout; when Orrerium
// is down the POST just fails silently.
const PORT = process.env.ORRERIUM_PORT || 4321;

setTimeout(() => process.exit(0), 1500); // hard cap, deliberately not unref'd

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', async () => {
  try {
    // BOM-strip: some shells (PowerShell pipes) prefix one; Claude Code doesn't
    const body = Buffer.concat(chunks).toString('utf8').replace(/^﻿/, '');
    await fetch(`http://127.0.0.1:${PORT}/api/hook-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(400),
    });
  } catch {
    // Orrerium down or slow - the session must never notice
  }
  process.exit(0);
});
