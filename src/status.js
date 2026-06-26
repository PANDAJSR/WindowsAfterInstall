import { readFile, writeFile } from 'node:fs/promises';
import pc from 'picocolors';

/**
 * 状态文件路径：系统盘根目录 wai_status.json。
 * 写根目录需管理员权限，故状态读写只在提权后的实例里进行。
 */
function statusPath() {
  const drive = process.env.SystemDrive || 'C:';
  return `${drive}\\wai_status.json`;
}

/**
 * @returns {Promise<object|null>}
 */
export async function loadStatus() {
  try {
    const data = await readFile(statusPath(), 'utf8');
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * 合并并写盘。首次写入时填 startedAt，每次刷新 updatedAt。
 * @param {object} patch
 * @returns {Promise<object>} 写入后的完整状态
 */
export async function saveStatus(patch = {}) {
  const cur = (await loadStatus()) || {
    version: 1,
    startedAt: null,
    updatedAt: null,
    finished: false,
    completedSteps: [],
    currentStep: null,
  };
  const now = new Date().toISOString();
  const next = { ...cur, ...patch, updatedAt: now };
  if (!next.startedAt) next.startedAt = now;
  await writeFile(statusPath(), JSON.stringify(next, null, 2) + '\n', 'utf8');
  return next;
}

/** 全新开始：写初始空状态。 */
export async function resetStatus() {
  const now = new Date().toISOString();
  const s = {
    version: 1,
    startedAt: now,
    updatedAt: now,
    finished: false,
    completedSteps: [],
    currentStep: null,
  };
  await writeFile(statusPath(), JSON.stringify(s, null, 2) + '\n', 'utf8');
  return s;
}

/** 标记即将开始执行某步。 */
export async function markCurrent(step) {
  return saveStatus({ currentStep: step, finished: false });
}

/** 标记某步已完成（completedSteps 去重）。 */
export async function markCompleted(step) {
  const s = (await loadStatus()) || (await saveStatus());
  const completed = Array.from(new Set([...(s.completedSteps || []), step]));
  return saveStatus({ completedSteps: completed, currentStep: null });
}

/** 全部流程完成。 */
export async function markFinished() {
  return saveStatus({ finished: true, currentStep: null });
}

/** 该步是否已在 completedSteps 中。 */
export function isStepDone(status, step) {
  return Boolean(status?.completedSteps?.includes(step));
}

export function statusFilePath() {
  return statusPath();
}
