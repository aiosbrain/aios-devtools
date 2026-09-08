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

function replaceStaleLock(lockPath, nowMs) {
  const recovery = `${lockPath}.recovery`;
  let guard;
  try { guard = openSync(recovery, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`finding observation output is locked: ${lockPath}`);
    throw error;
  }
  try {
    let lock;
    try { lock = JSON.parse(readFileSync(lockPath, "utf8")); }
    catch { throw new Error(`finding observation lock is invalid: ${lockPath}`); }
    const createdAt = Number(lock.created_at_ms); const modifiedAt = statSync(lockPath).mtimeMs;
    if (!Number.isFinite(createdAt) || !Number.isFinite(modifiedAt)) throw new Error(`finding observation lock is invalid: ${lockPath}`);
    if (nowMs - Math.max(createdAt, modifiedAt) <= STALE_MS || pidAlive(Number(lock.pid))) {
      throw new Error(`finding observation output is locked: ${lockPath}`);
    }
    unlinkSync(lockPath);
    const fd = openSync(lockPath, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, created_at_ms: nowMs })}\n`); closeSync(fd);
  } finally {
    if (guard !== undefined) closeSync(guard);
    if (existsSync(recovery)) unlinkSync(recovery);
  }
}

function acquireLock(lockPath, nowMs) {
  try {
    const fd = openSync(lockPath, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify({ pid: process.pid, created_at_ms: nowMs })}\n`); closeSync(fd);
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
