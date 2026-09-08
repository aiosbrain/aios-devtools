import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const STALE_MS = 15 * 60 * 1000;

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== "ESRCH"; }
}

function lockState(lockPath, nowMs, { allowInvalid = false } = {}) {
  let lock;
  try { lock = JSON.parse(readFileSync(lockPath, "utf8")); }
  catch {
    const modifiedAt = statSync(lockPath).mtimeMs;
    if (allowInvalid && Number.isFinite(modifiedAt) && nowMs - modifiedAt > STALE_MS) return { stale: true, lock: null };
    throw new Error(`finding observation lock is invalid: ${lockPath}`);
  }
  const createdAt = Number(lock.created_at_ms); const modifiedAt = statSync(lockPath).mtimeMs;
  if (!Number.isFinite(createdAt) || !Number.isFinite(modifiedAt)) throw new Error(`finding observation lock is invalid: ${lockPath}`);
  return { lock, stale: nowMs - Math.max(createdAt, modifiedAt) > STALE_MS && !pidAlive(Number(lock.pid)) };
}

function createLock(lockPath, nowMs) {
  const nonce = randomUUID();
  const fd = openSync(lockPath, "wx", 0o600);
  writeFileSync(fd, `${JSON.stringify({ pid: process.pid, created_at_ms: nowMs, nonce })}\n`); closeSync(fd);
  return nonce;
}

function replaceStaleLock(lockPath, nowMs) {
  const initial = lockState(lockPath, nowMs);
  if (!initial.stale) throw new Error(`finding observation output is locked: ${lockPath}`);
  const nonce = typeof initial.lock?.nonce === "string" ? initial.lock.nonce : "legacy";
  const recovery = `${lockPath}.recovery-${nonce}`;
  let guard;
  try { guard = createLock(recovery, nowMs); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (!lockState(recovery, nowMs, { allowInvalid: true }).stale) throw new Error(`finding observation output is locked: ${lockPath}`);
    unlinkSync(recovery);
    try { guard = createLock(recovery, nowMs); }
    catch { throw new Error(`finding observation output is locked: ${lockPath}`); }
  }
  try {
    const current = lockState(lockPath, nowMs);
    if (!current.stale || (initial.lock?.nonce !== undefined && current.lock?.nonce !== initial.lock.nonce)) {
      throw new Error(`finding observation output is locked: ${lockPath}`);
    }
    unlinkSync(lockPath);
    createLock(lockPath, nowMs);
  } finally {
    void guard;
    if (existsSync(recovery)) unlinkSync(recovery);
  }
}

function acquireLock(lockPath, nowMs) {
  try {
    createLock(lockPath, nowMs);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    replaceStaleLock(lockPath, nowMs);
  }
}

export function writeAtomicJsonl(outputPath, bytes, { nowMs = Date.now() } = {}) {
  const target = path.resolve(outputPath); const lock = `${target}.lock`;
  mkdirSync(path.dirname(target), { recursive: true }); acquireLock(lock, nowMs);
  const temp = `${target}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, bytes, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, target);
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
    if (existsSync(lock)) unlinkSync(lock);
  }
}
