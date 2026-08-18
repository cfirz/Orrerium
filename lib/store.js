// Orrerium-owned writable state under data/. The vault stays read-only; every
// module that persists anything (hook events, icon assignments, cron defs)
// goes through here so the formats stay uniform: JSON documents and NDJSON
// append-only logs.
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export function readJson(file, fallback) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(text);
  } catch {
    return fallback; // torn or hand-mangled file - callers get the fallback, never a throw
  }
}

export function writeJson(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2));
  renameSync(tmp, file); // atomic on the same volume - readers never see a half-written file
}

export function appendLine(file, obj) {
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(obj)}\n`);
}

export function readLines(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a torn tail line from a crash mid-append - drop it, keep the rest
    }
  }
  return out;
}
