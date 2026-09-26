// Fronteira falsa do Codex CLI: processo real, sem modelo, rede ou produto real.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
const [caso, ...args] = process.argv.slice(2)
let c = JSON.parse(readFileSync(caso, 'utf8'))
const valor = flag => args[args.indexOf(flag) + 1]
const saida = valor('--output-last-message')
const schema = JSON.parse(readFileSync(valor('--output-schema'), 'utf8'))
const pedido = JSON.parse(readFileSync(join(dirname(saida), 'pedido.json'), 'utf8'))
c = { ...c, ...(c.porLabel?.[pedido.opcoes.label] ?? {}) }
const inicio = Date.now()
let prompt = ''
for await (const chunk of process.stdin) prompt += chunk
if (c.demoraMs) await new Promise(r => setTimeout(r, c.demoraMs))
let resultado = c.resultado
if (c.preVooBloqueado) {
  if (pedido.opcoes.label === 'preparo') resultado = { saida: execFileSync(process.execPath, ['.claude/missao/git-estado.mjs', 'HEAD'], { cwd: valor('--cd'), encoding: 'utf8' }) }
  else if (pedido.opcoes.label === 'pré-voo') resultado = { ok: false, faltando: ['fixture-sem-docker'] }
  else throw new Error(`Agente inesperado no teste: ${pedido.opcoes.label}`)
}
writeFileSync(join(dirname(saida), 'captura.json'), JSON.stringify({ args, prompt, schema, inicio, fim: Date.now() }))
writeFileSync(saida, c.bruto ?? JSON.stringify({ bloqueado: c.bloqueado ?? false, motivo: c.motivo ?? '', resultado: resultado ?? null }))
process.stdout.write('{"type":"fixture.finished"}\n')
process.stderr.write('fixture stderr\n')
process.exitCode = c.codigo ?? 0
