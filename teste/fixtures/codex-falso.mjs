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
if (c.preVooBloqueado || c.missaoSemMudancas) {
  if (['preparo', 'conferência'].includes(pedido.opcoes.label)) {
    const params = pedido.prompt.match(/git-estado\.mjs ([^\x60\r\n]+)/)[1].trim().split(/\s+/)
    resultado = { saida: execFileSync(process.execPath, ['.claude/missao/git-estado.mjs', ...params], { cwd: valor('--cd'), encoding: 'utf8' }) } }
  else if (pedido.opcoes.label === 'pré-voo') resultado = c.preVooBloqueado ? { ok: false, faltando: ['fixture-sem-docker'] } : { ok: true, faltando: [] }
  else if (pedido.opcoes.label === 'contexto do plano') resultado = { areas: [{ nome: 'teste', guia: 'Somente confirmar que a entrega já existe.', features: ['F1'] }] }
  else if (pedido.opcoes.label.startsWith('contrato:')) resultado = { premissas: [] }
  else if (pedido.opcoes.label.startsWith('telas:')) resultado = { ui: '' }
  else if (pedido.opcoes.label === 'F1') {
    writeFileSync(join(valor('--cd'), 'saida.txt'), 'fixture de modelo, não produto real\\n')
    resultado = { concluida: true, arquivos: ['saida.txt'], resumo: 'Fixture criada.', mensagem: 'feat: fixture' }
  }
  else if (pedido.opcoes.label === 'commit: F1') {
    const git = (...a) => execFileSync('git', ['-C', valor('--cd'), '-c', 'user.name=Teste', '-c', 'user.email=teste@example.invalid', ...a], { encoding: 'utf8' }).trim()
    git('add', '--', 'saida.txt'); git('commit', '-qm', 'feat: fixture', '--', 'saida.txt')
    resultado = { saida: 'saida=0\nhead=' + git('rev-parse', 'HEAD') }
  }
  else if (pedido.opcoes.label.startsWith('áreas de caça:')) resultado = { areas: [] }
  else if (pedido.opcoes.label.startsWith('caça:')) resultado = { achados: [] }
  else if (pedido.opcoes.label === 'aceite') resultado = { criterios: [{ criterio: 'teste', evidencia: 'Árvore Git preservada.', atendido: true }] }
  else if (pedido.opcoes.label.startsWith('revisão:') || pedido.opcoes.label.startsWith('testes:') || pedido.opcoes.label === 'suíte completa') resultado = { aprovado: true, problemas: [] }
  else throw new Error(`Agente inesperado no teste: ${pedido.opcoes.label}`)
}
writeFileSync(join(dirname(saida), 'captura.json'), JSON.stringify({ args, prompt, schema, inicio, fim: Date.now() }))
writeFileSync(saida, c.bruto ?? JSON.stringify({ bloqueado: c.bloqueado ?? false, motivo: c.motivo ?? '', resultado: resultado ?? null }))
process.stdout.write('{"type":"fixture.finished"}\n')
process.stderr.write('fixture stderr\n')
process.exitCode = c.codigo ?? 0
