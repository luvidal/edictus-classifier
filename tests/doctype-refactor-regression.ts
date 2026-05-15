/**
 * Regression guard for the parent Jogi doctype YAML refactor.
 *
 * The refactor may rewrite top-level `definition` and add/update
 * top-level `classifier`. Legacy consumer fields must remain structurally
 * identical to the pre-YAML JSON snapshot.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'

const DEFAULT_BACKUP = 'docs/artifacts/doctype-yaml-refactor/doctypes.pre-yaml-20260514.json'
const DEFAULT_CURRENT = process.env.JOGI_DOCTYPES || '/Users/avd/GitHub/jogi/data/doctypes.json'
const ALLOWED_TOP_LEVEL_DIFFS = new Set(['definition', 'classifier'])

function argValue(name: string): string | null {
    const prefix = `--${name}=`
    const hit = process.argv.slice(2).find(a => a.startsWith(prefix))
    return hit ? hit.slice(prefix.length) : null
}

function readCatalog(file: string): Record<string, unknown> {
    if (!fs.existsSync(file)) throw new Error(`missing catalog: ${file}`)
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`catalog must be an object keyed by doctype id: ${file}`)
    }
    return parsed as Record<string, unknown>
}

function sha256(file: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function legacyShape(value: unknown): unknown {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .filter(([key]) => !ALLOWED_TOP_LEVEL_DIFFS.has(key))
            .map(([key, child]) => [key, sortJson(child)]),
    )
}

function sortJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(sortJson)
    if (!value || typeof value !== 'object') return value
    return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, child]) => [key, sortJson(child)]),
    )
}

function stable(value: unknown): string {
    return JSON.stringify(sortJson(value))
}

function diffIds(before: string[], after: string[]): string[] {
    const a = new Set(before)
    const b = new Set(after)
    return [
        ...before.filter(id => !b.has(id)).map(id => `missing current id: ${id}`),
        ...after.filter(id => !a.has(id)).map(id => `new current id: ${id}`),
    ]
}

function main(): void {
    const backupPath = path.resolve(argValue('backup') || DEFAULT_BACKUP)
    const currentPath = path.resolve(argValue('current') || DEFAULT_CURRENT)
    const backup = readCatalog(backupPath)
    const current = readCatalog(currentPath)

    const backupIds = Object.keys(backup).sort()
    const currentIds = Object.keys(current).sort()
    const problems = diffIds(backupIds, currentIds)

    for (const id of backupIds) {
        if (!(id in current)) continue
        const before = stable(legacyShape(backup[id]))
        const after = stable(legacyShape(current[id]))
        if (before !== after) problems.push(`legacy field drift: ${id}`)
    }

    if (problems.length) {
        console.error(`Doctype refactor regression check failed (${problems.length} issue(s)):`)
        for (const problem of problems.slice(0, 40)) console.error(`- ${problem}`)
        if (problems.length > 40) console.error(`- ... ${problems.length - 40} more`)
        console.error('\nAllowed top-level diffs: definition, classifier')
        console.error(`Backup:  ${backupPath}`)
        console.error(`Current: ${currentPath}`)
        process.exitCode = 1
        return
    }

    console.log(`Doctype refactor regression check passed (${backupIds.length} doctypes).`)
    console.log(`Backup SHA-256:  ${sha256(backupPath)}`)
    console.log(`Current SHA-256: ${sha256(currentPath)}`)
}

main()
