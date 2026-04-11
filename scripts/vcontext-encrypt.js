#!/usr/bin/env node
/**
 * vcontext-encrypt.js — Encrypt/decrypt vcontext database for secure transport
 *
 * Usage:
 *   node vcontext-encrypt.js encrypt <input.db> <output.enc> [password]
 *   node vcontext-encrypt.js decrypt <input.enc> <output.db> [password]
 *   node vcontext-encrypt.js export   — encrypt SSD backup for cloud/transport
 *   node vcontext-encrypt.js import <file.enc>  — decrypt and restore
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const BACKUP_DIR = join(process.env.HOME, 'skills', 'data');
const SSD_DB = join(BACKUP_DIR, 'vcontext-ssd.db');
const EXPORT_PATH = join(BACKUP_DIR, 'vcontext-export.enc');
const KEY_FILE = join(BACKUP_DIR, '.vcontext-key');

function getKey(password) {
  if (password) return scryptSync(password, 'vcontext-salt-2026', 32);
  // Auto-generated key stored locally
  if (existsSync(KEY_FILE)) return readFileSync(KEY_FILE);
  const key = randomBytes(32);
  writeFileSync(KEY_FILE, key, { mode: 0o600 });
  console.log(`Generated encryption key at ${KEY_FILE}`);
  return key;
}

function encrypt(inputPath, outputPath, password) {
  const key = getKey(password);
  const iv = randomBytes(16);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = readFileSync(inputPath);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: [16 bytes IV][16 bytes auth tag][encrypted data]
  const output = Buffer.concat([iv, tag, encrypted]);
  writeFileSync(outputPath, output);
  console.log(`Encrypted: ${inputPath} → ${outputPath} (${data.length} → ${output.length} bytes)`);
}

function decrypt(inputPath, outputPath, password) {
  const key = getKey(password);
  const data = readFileSync(inputPath);
  const iv = data.subarray(0, 16);
  const tag = data.subarray(16, 32);
  const encrypted = data.subarray(32);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  writeFileSync(outputPath, decrypted);
  console.log(`Decrypted: ${inputPath} → ${outputPath} (${data.length} → ${decrypted.length} bytes)`);
}

const [cmd, arg1, arg2, arg3] = process.argv.slice(2);

switch (cmd) {
  case 'encrypt':
    if (!arg1 || !arg2) { console.error('Usage: encrypt <input> <output> [password]'); process.exit(1); }
    encrypt(arg1, arg2, arg3);
    break;
  case 'decrypt':
    if (!arg1 || !arg2) { console.error('Usage: decrypt <input> <output> [password]'); process.exit(1); }
    decrypt(arg1, arg2, arg3);
    break;
  case 'export':
    if (!existsSync(SSD_DB)) { console.error('SSD database not found'); process.exit(1); }
    encrypt(SSD_DB, EXPORT_PATH, arg1);
    console.log(`Export ready: ${EXPORT_PATH}`);
    break;
  case 'import':
    if (!arg1 || !existsSync(arg1)) { console.error('Usage: import <file.enc> [password]'); process.exit(1); }
    const restorePath = join(BACKUP_DIR, 'vcontext-import.db');
    decrypt(arg1, restorePath, arg2);
    console.log(`Decrypted to: ${restorePath}`);
    console.log(`To restore: cp ${restorePath} ${SSD_DB}`);
    break;
  default:
    console.log(`vcontext-encrypt — Encrypt/decrypt virtual context databases

Commands:
  encrypt <input.db> <output.enc> [password]
  decrypt <input.enc> <output.db> [password]
  export [password]     — Encrypt SSD backup for transport
  import <file> [pass]  — Decrypt and prepare for restore

Without password, uses auto-generated key at ${KEY_FILE}`);
}
