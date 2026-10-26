import test from 'node:test'
import assert from 'node:assert/strict'
import { canApprovePullRequest, filterAfterViewChange, identifyIssue, runFilterChecks, transitionNote } from './review.ts'
import type { ReviewNote } from './review.ts'

function note(stage: ReviewNote['stage']): ReviewNote {
  return { id: 1, text: 'Preserve filters', kind: 'filters', target: 'Filters', point: { x: 20, y: 20 }, context: { view: 'board', filter: 'In progress', search: '', steps: [] }, stage }
}

test('reviewer and author approval are both required before approving the PR', () => {
  for (const stage of ['queued', 'reproducing', 'verifying', 'proposed', 'accepted', 'needs-context'] as const) {
    assert.equal(canApprovePullRequest([note(stage)]), false, stage)
  }
  assert.equal(canApprovePullRequest([note('author-approved')]), true)
  assert.equal(canApprovePullRequest([note('author-approved'), note('proposed')]), false)
  assert.equal(canApprovePullRequest([]), true)
})

test('a patch cannot skip verification or either approval', () => {
  assert.equal(transitionNote(note('queued'), 'author-approved').stage, 'queued')
  assert.equal(transitionNote(note('verifying'), 'accepted').stage, 'verifying')
  assert.equal(transitionNote(note('proposed'), 'author-approved').stage, 'proposed')
  assert.equal(transitionNote(note('proposed'), 'accepted').stage, 'accepted')
  assert.equal(transitionNote(note('accepted'), 'author-approved').stage, 'author-approved')
})

test('the fixture reproduces the regression before the patch and passes afterward', () => {
  assert.equal(filterAfterViewChange('In progress', false), 'All statuses')
  assert.equal(filterAfterViewChange('In progress', true), 'In progress')
  assert.equal(runFilterChecks(false).filter(check => !check.passed).length, 2)
  assert.equal(runFilterChecks(true).every(check => check.passed), true)
})

test('unsupported feedback requests context instead of inventing a patch', () => {
  assert.equal(identifyIssue('Keep my filters when switching views'), 'filters')
  assert.equal(identifyIssue('Add a useful empty state'), 'empty-state')
  assert.equal(identifyIssue('Give the search an accessible label'), 'accessibility')
  assert.equal(identifyIssue('Rewrite the database'), 'unknown')
  assert.equal(transitionNote(note('queued'), 'needs-context').stage, 'needs-context')
  assert.equal(canApprovePullRequest([note('needs-context')]), false)
})
