/**
 * Durable course store: persists the loaded question bank per workspace so it
 * survives process restarts. Pure JSON file under
 * `$DSH_HOME/state/dsh-teacher/course-<workspace>.json` (workspace slashes
 * are sanitized). No dsh/zod imports — testable in isolation.
 * @module dsh-teacher/course-store
 */

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

/** Durable course file for a workspace. */
export function courseFilePath(workspace) {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  const safe = String(workspace).replace(/[^a-z0-9-_]/gi, '_')
  return join(home, 'state', 'dsh-teacher', `course-${safe}.json`)
}

/**
 * Persist a course for a workspace (overwrites any previous course).
 * @param workspace - workspace key (cwd path).
 * @param course - the parsed curriculum object.
 * @returns the written file path.
 */
export function saveCourse(workspace, course) {
  const path = courseFilePath(workspace)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(course), 'utf8')
  return path
}

/**
 * Load the persisted course for a workspace, or null when none is stored.
 * @param workspace - workspace key.
 * @returns the parsed course, or null.
 */
export function loadCourse(workspace) {
  const path = courseFilePath(workspace)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}
