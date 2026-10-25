import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { LAB_ROOT } from '../lib/arms.ts'
import { extractChangeRequests, frameworkParagraph, renderCrKickoff, renderKickoff } from '../lib/kickoff.ts'

const FORBIDDEN = /benchmark|experiment|hidden suite|\btraps?\b|private\/|murmur-lab/i

test('the two kickoffs differ only in the framework paragraph', () => {
  const murmur = renderKickoff('murmur', { FRAMEWORK_REF: '/x' })
  const nest = renderKickoff('nestjs')
  const strip = (text: string, paragraph: string) => text.replace(paragraph, '<FRAMEWORK>')

  assert.equal(strip(murmur, frameworkParagraph('murmur', { FRAMEWORK_REF: '/x' })), strip(nest, frameworkParagraph('nestjs')))
  assert.notEqual(murmur, nest)
})

test('kickoffs never mention the study, the sealed material or the other arm', () => {
  const murmur = renderKickoff('murmur', { FRAMEWORK_REF: '/x' })
  const nest = renderKickoff('nestjs')

  assert.doesNotMatch(murmur, FORBIDDEN)
  assert.doesNotMatch(nest, FORBIDDEN)
  assert.doesNotMatch(murmur, /nest/i)
  assert.doesNotMatch(nest, /murmur/i)
})

test('experiment/KICKOFF-*.md files are exactly the rendered templates', () => {
  for (const fw of ['murmur', 'nestjs'] as const) {
    const onDisk = readFileSync(join(LAB_ROOT, 'experiment', `KICKOFF-${fw}.md`), 'utf8')

    assert.equal(onDisk, renderKickoff(fw), `KICKOFF-${fw}.md is out of sync with harness/templates`)
  }
})

test('both kickoffs fix SQLite in the shared section, not in the framework paragraph', () => {
  for (const fw of ['murmur', 'nestjs'] as const) {
    assert.match(renderKickoff(fw), /- Use SQLite as the database engine\./)
    assert.doesNotMatch(frameworkParagraph(fw), /SQLite|database engine/i)
  }
})

test('unfilled placeholders survive so the murmur ref is visible', () => {
  assert.match(renderKickoff('murmur'), /\{\{FRAMEWORK_REF\}\}/)
  assert.doesNotMatch(renderKickoff('murmur', { FRAMEWORK_REF: '/opt/fw' }), /\{\{/)
})

test('change requests are extracted without their acceptance criteria', () => {
  const crs = extractChangeRequests(readFileSync(join(LAB_ROOT, 'experiment', 'PHASE2.md'), 'utf8'))

  assert.deepEqual(
    crs.map((c) => c.id),
    ['CR-1', 'CR-2', 'CR-3'],
  )
  for (const cr of crs) {
    assert.doesNotMatch(cr.text, /Acceptance criteria|hidden test|sealed/i)
    assert.match(cr.text, /### Request/)
    assert.match(cr.text, /### Specification/)
    const kickoff = renderCrKickoff('nestjs', cr)
    assert.match(kickoff, new RegExp(`DONE-${cr.id}\\.md`))
    assert.doesNotMatch(kickoff, FORBIDDEN)
  }
})
