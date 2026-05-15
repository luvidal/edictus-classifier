/**
 * OBSOLETE as a generation-parameter bakeoff. The classifier model and
 * generation profile are satellite-owned (`src/index.ts`) and cannot be
 * overridden at call time, so `classify()` no longer accepts `model` /
 * `generationConfig`. This harness now just runs the high-signal failure
 * subset once against the satellite-default profile.
 *
 *   npm run param-sweep            # high-signal subset
 *   npm run param-sweep -- --full  # whole active corpus
 */

import * as fs from 'fs'
import * as path from 'path'
import { runGroundtruthComparison } from './groundtruth'

const WRONG_LABEL_FILES = [
    '_reqdocs/cta rara.png',
    'evaluacion/DAI 2024.pdf',
    'evaluacion/Inv Santander (1).pdf',
    'evaluacion/Inv Santander.pdf',
    'evaluacion/VentaProp Lo Barnechea.pdf',
    'evucina/Consumo Scotiabank.png',
    'evucina/Hipo Banco.pdf',
    'evucina/VentaProp Las Cabras.pdf',
    'evucina/VentaProp Lo Barnechea.pdf',
    'gloria/Carpeta.pdf',
    'yulian/YULIAN GARCIA/Cartola Santander.pdf',
]

function stamp(): string {
    return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
}

async function main() {
    const full = process.argv.includes('--full')
    const outDir = path.resolve('out/param-sweep', stamp())
    fs.mkdirSync(outDir, { recursive: true })
    const outPath = path.join(outDir, 'satellite-default-profile.json')
    const result = await runGroundtruthComparison({
        files: full ? undefined : new Set(WRONG_LABEL_FILES),
        outPath,
        label: 'satellite-default-profile',
    })
    const summaryPath = path.join(outDir, 'summary.json')
    fs.writeFileSync(summaryPath, JSON.stringify({
        runAt: new Date().toISOString(),
        full,
        files: full ? 'all' : WRONG_LABEL_FILES,
        summary: [{
            label: 'satellite-default-profile',
            passCount: result.passCount,
            total: result.total,
            passRate: result.total ? result.passCount / result.total : 0,
            outPath,
        }],
    }, null, 2))
    console.log(`\nWrote ${summaryPath}`)
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1) })
