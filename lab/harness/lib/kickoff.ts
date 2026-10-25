import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Framework } from './arms.ts'

const TEMPLATES = join(import.meta.dirname, '../templates')

export interface ChangeRequest {
  id: string
  title: string
  text: string
}

function template(name: string): string {
  return readFileSync(join(TEMPLATES, name), 'utf8').trimEnd()
}

export function fill(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{([A-Z_]+)\}\}/g, (whole, key: string) => vars[key] ?? whole)
}

export function frameworkParagraph(framework: Framework, vars: Record<string, string> = {}): string {
  return fill(template(`framework-${framework}.md`), vars)
}

function partials(framework: Framework, vars: Record<string, string>): Record<string, string> {
  return { FRAMEWORK_PARAGRAPH: frameworkParagraph(framework, vars), PROCESS: template('process.md') }
}

export function renderKickoff(framework: Framework, vars: Record<string, string> = {}): string {
  return `${fill(template('kickoff.md'), partials(framework, vars))}\n`
}

export function renderCrKickoff(framework: Framework, cr: ChangeRequest, vars: Record<string, string> = {}): string {
  const all = { ...partials(framework, vars), CR_ID: cr.id, CR_TEXT: cr.text }

  return `${fill(template('kickoff-cr.md'), all)}\n`
}

export function extractChangeRequests(phase2Markdown: string): ChangeRequest[] {
  const sections = phase2Markdown.split(/^## (?=CR-\d+:)/m).slice(1)

  return sections.map((section) => {
    const [heading = '', ...rest] = section.split('\n')
    const match = /^(CR-\d+):\s*(.+)$/.exec(heading.trim())
    if (!match) throw new Error(`malformed change request heading: ${heading}`)
    const body = rest.join('\n').split(/^### Acceptance criteria/m)[0] ?? ''
    const text = body.replace(/^---\s*$/gm, '').trim()

    return { id: match[1] as string, title: (match[2] as string).trim(), text: `**${(match[2] as string).trim()}**\n\n${text}` }
  })
}
