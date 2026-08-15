/**
 * Course persistence: the loaded question bank must survive process restarts.
 * Tests the pure lib/course-store.js (save + reload by workspace).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseCurriculum } from '../lib/curriculum.js'
import { courseFilePath, saveCourse, loadCourse } from '../lib/course-store.js'

test('saveCourse/loadCourse round-trips a course by workspace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-teacher-persist-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    const workspace = '/Users/me/projects/demo'
    const course = parseCurriculum('## Q1: What is X?\n<!-- answer: Y -->\n')
    assert.ok(course.questions.length > 0, 'fixture parses')

    const written = saveCourse(workspace, course)
    assert.ok(written.endsWith('course-_Users_me_projects_demo.json'), 'filename sanitized')

    const loaded = loadCourse(workspace)
    assert.ok(loaded !== null, 'course reloaded from disk')
    assert.equal(loaded.questions.length, course.questions.length)
    assert.equal(loaded.questions[0].id, course.questions[0].id)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadCourse returns null when no course is stored', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-teacher-persist-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    assert.equal(loadCourse('/no/course/here'), null)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(dir, { recursive: true, force: true })
  }
})

test('courseFilePath sanitizes the workspace into a filename', () => {
  assert.match(courseFilePath('/a/b c!d'), /course-_a_b_c_d\.json$/)
})
