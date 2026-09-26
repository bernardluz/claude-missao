import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { instalar } from '../instalar.mjs'

const fixture = fileURLToPath(new URL('./fixtures/codex-falso.mjs', import.meta.url))
const schema = { type: 'object', properties: {
  ok: { type: 'boolean' }, detalhe: { type: 'string' },
  itens: { type: 'array', maxItems: 2, items: { type: 'object', properties: { nome: { type: 'string' }, peso: { type: 'integer' } }, required: ['nome'] } },
}, required: ['ok'] }
const temp = () => mkdtempSync(join(tmpdir(), 'missao-codex-'))
const ler = p => JSON.parse(readFileSync(p, 'utf8'))
const escrever = (p, v) => writeFileSync(p, JSON.stringify(v))
function projeto() {
  const raiz = temp()
  const git = (...args) => execFileSync('git', ['-C', raiz, '-c', 'user.name=Teste', '-c', 'user.email=teste@example.invalid', ...args], { encoding: 'utf8' }).trim()
  git('init', '-q', '-b', 'codex/teste')
  writeFileSync(join(raiz, '.gitignore'), '.claude/\n')
  git('add', '.gitignore'); git('commit', '-qm', 'base')
  instalar(raiz)
  return { raiz, git }
}
const argsMissao = { milestones: [{ titulo: 'M1', criterio: 'teste', features: [{ titulo: 'F1', spec: 'Não executar: pré-voo bloqueia.' }] }] }
async function agenteFalso(cenario = {}, extras = {}) {
  const { criarAgenteCodex } = await import('../codex/agente.mjs')
  const registros = temp()
  const caso = join(registros, 'cenario.json')
  escrever(caso, cenario)
  const agent = criarAgenteCodex({ projeto: registros, registros, comando: [process.execPath, fixture, caso], ...extras })
  return { agent, registros }
}

test('schema estrito mantém required e normaliza somente opcionais null, inclusive aninhados', async () => {
  const { schemaEstrito, normalizarResultado } = await import('../codex/schema.mjs')
  const antes = JSON.stringify(schema)
  const s = schemaEstrito(schema)
  assert.equal(s.additionalProperties, false)
  assert.deepEqual(s.required, ['ok', 'detalhe', 'itens'])
  assert.ok(s.properties.detalhe.anyOf.some(x => x.type === 'null'))
  assert.deepEqual(normalizarResultado({ ok: false, detalhe: null, itens: [{ nome: 'x', peso: null }] }, schema), { ok: false, itens: [{ nome: 'x' }] })
  assert.equal(JSON.stringify(schema), antes)
})

test('schema recusa required ausente, tipo falso, propriedade extra e limite de array', async () => {
  const { normalizarResultado, schemaEstrito } = await import('../codex/schema.mjs')
  for (const valor of [{}, { ok: null }, { ok: 'true' }, { ok: true, extra: 1 }, { ok: true, itens: [{ nome: 'x', peso: 1.5 }] }, { ok: true, itens: [{ nome: 'a' }, { nome: 'b' }, { nome: 'c' }] }]) {
    assert.throws(() => normalizarResultado(valor, schema), /schema|contrato/i)
  }
  assert.throws(() => schemaEstrito({ type: 'object', patternProperties: {} }), /suportad|schema/i)
})

test('CLI recebe stdin literal, schema e arquivos de saída, com sandbox e sem bypass', async () => {
  const { agent, registros } = await agenteFalso({ resultado: { ok: true, detalhe: null, itens: null } })
  const prompt = 'Teste com acento e aspas: "ação"; $(não executar)'
  assert.deepEqual(await agent(prompt, { label: 'revisão: F1', phase: 'Implementar', schema, model: 'haiku', effort: 'low' }), { ok: true })
  const chamada = readdirSync(registros).find(x => /^agente-/.test(x))
  const captura = ler(join(registros, chamada, 'captura.json'))
  assert.ok(captura.prompt.includes(prompt))
  assert.equal(captura.args.at(-1), '-')
  assert.equal(captura.args[captura.args.indexOf('--sandbox') + 1], 'read-only')
  assert.ok(captura.args.includes('--no-daemon'))
  assert.equal(captura.args[captura.args.indexOf('--ask-for-approval') + 1], 'never')
  assert.ok(!captura.args.some(x => /bypass|ignore-rules|ignore-user-config|danger-full-access/.test(x)))
  assert.ok(!captura.args.includes('haiku'))
  assert.equal(captura.schema.additionalProperties, false)
  assert.ok(existsSync(join(registros, chamada, 'stdout.jsonl')))
  assert.ok(existsSync(join(registros, chamada, 'stderr.log')))
})

test('worker usa workspace-write e auto-review só por opção explícita; papel ausente não é ignorado', async () => {
  const { agent, registros } = await agenteFalso({ resultado: { ok: true } }, { aprovacao: 'auto', modelo: 'modelo-do-operador' })
  await agent('implementar', { label: 'F1', phase: 'Implementar', schema })
  const chamada = readdirSync(registros).find(x => /^agente-/.test(x))
  const captura = ler(join(registros, chamada, 'captura.json'))
  assert.equal(captura.args[captura.args.indexOf('--sandbox') + 1], 'workspace-write')
  assert.ok(captura.args.includes('--approve-for-me'))
  assert.ok(captura.args.includes('modelo-do-operador'))
  const outro = await agenteFalso({ resultado: { ok: true } })
  await assert.rejects(outro.agent('revisar', { label: 'revisão: F1', phase: 'Implementar', schema, agentType: 'nao-existe' }), /papel|agente.*ausente/i)
  const terceiro = await agenteFalso({ resultado: { ok: true } })
  await assert.rejects(terceiro.agent('revisar', { label: 'revisão: F1', phase: 'Implementar', schema, agentType: '../fora' }), /papel|inválido/i)
})

test('papel Codex do projeto tem precedência sem obedecer seu modelo Claude', async () => {
  const { agent, registros } = await agenteFalso({ resultado: { ok: true } })
  for (const pasta of ['.codex', '.claude']) mkdirSync(join(registros, pasta, 'agents'), { recursive: true })
  writeFileSync(join(registros, '.codex', 'agents', 'reviewer.md'), '---\nmodel: sonnet\n---\nREVISOR_CODEX_TESTE')
  writeFileSync(join(registros, '.claude', 'agents', 'reviewer.md'), 'REVISOR_CLAUDE_TESTE')
  await agent('revisar', { label: 'revisão: F1', phase: 'Implementar', schema, agentType: 'reviewer' })
  const chamada = readdirSync(registros).find(x => /^agente-/.test(x))
  const captura = ler(join(registros, chamada, 'captura.json'))
  assert.match(captura.prompt, /REVISOR_CODEX_TESTE/)
  assert.doesNotMatch(captura.prompt, /REVISOR_CLAUDE_TESTE/)
  assert.ok(!captura.args.includes('sonnet'))
})

test('recusa, JSON inválido, schema inválido e exit não zero nunca viram aprovação', async () => {
  for (const cenario of [{ bloqueado: true, motivo: 'permissão negada' }, { bruto: 'não é JSON' }, { resultado: { ok: 'true' } }, { codigo: 7, resultado: { ok: true } }]) {
    const { agent } = await agenteFalso(cenario)
    await assert.rejects(agent('teste', { label: 'F1', phase: 'Implementar', schema }), /bloque|JSON|schema|contrato|código|Codex/i)
  }
})

test('timeout encerra o CLI sem repetir a chamada', async () => {
  const { agent, registros } = await agenteFalso({ demoraMs: 5000, resultado: { ok: true } }, { timeoutMs: 150 })
  await assert.rejects(agent('teste', { label: 'F1', phase: 'Implementar', schema }), /tempo|timeout/i)
  assert.equal(readdirSync(registros).filter(x => /^agente-/.test(x)).length, 1)
})

test('limite de agentes funciona mesmo com chamadas simultâneas', async () => {
  const { agent, registros } = await agenteFalso({ demoraMs: 180, resultado: { ok: true } }, { concorrencia: 1 })
  await Promise.all([1, 2, 3].map(n => agent('teste', { label: `F${n}`, phase: 'Implementar', schema })))
  const intervalos = readdirSync(registros).filter(x => /^agente-/.test(x)).map(x => ler(join(registros, x, 'captura.json'))).sort((a,b) => a.inicio-b.inicio)
  for (let i=1; i<intervalos.length; i++) assert.ok(intervalos[i].inicio >= intervalos[i-1].fim)
})

test('workflow instalado chega ao pré-voo pelo subprocesso e preserva parada/retomar fora do repo', async () => {
  const { rodarMissao } = await import('../codex/rodar.mjs')
  const { raiz, git } = projeto()
  const estado = temp(), caso = join(estado, 'cenario.json')
  escrever(caso, { preVooBloqueado: true })
  const opcoes = { projeto: raiz, args: argsMissao, pastaEstado: estado, comando: [process.execPath, fixture, caso] }
  const r = await rodarMissao(opcoes)
  assert.equal(r.resultado.parouEm, 'pré-voo')
  assert.ok(r.resultado.retomar)
  assert.equal(ler(r.arquivoResultado).resultado.parouEm, 'pré-voo')
  assert.equal(git('status', '--porcelain'), '')
  const antes = readFileSync(r.arquivoResultado, 'utf8')
  const retomada = await rodarMissao({ ...opcoes, args: undefined, retomar: r.arquivoResultado })
  assert.notEqual(r.arquivoResultado, retomada.arquivoResultado)
  assert.equal(readFileSync(r.arquivoResultado, 'utf8'), antes)
  assert.equal(retomada.resultado.parouEm, 'pré-voo')
})

test('runner recusa workflow adulterado, estado dentro do repo e retomada de outro projeto', async () => {
  const { rodarMissao } = await import('../codex/rodar.mjs')
  const { raiz } = projeto(), estado = temp()
  await assert.rejects(rodarMissao({ projeto: raiz, args: argsMissao, pastaEstado: join(raiz, 'estado') }), /fora|repositório/i)
  writeFileSync(join(raiz, '.claude', 'workflows', 'missao.js'), 'throw new Error("nao executar")')
  await assert.rejects(rodarMissao({ projeto: raiz, args: argsMissao, pastaEstado: estado }), /instal|desatualiz|workflow/i)
  instalar(raiz, { forcar: true })
  const caso = join(estado, 'cenario.json'); escrever(caso, { preVooBloqueado: true })
  const r = await rodarMissao({ projeto: raiz, args: argsMissao, pastaEstado: estado, comando: [process.execPath, fixture, caso] })
  const outro = projeto()
  await assert.rejects(rodarMissao({ projeto: outro.raiz, retomar: r.arquivoResultado, pastaEstado: estado }), /projeto|checkout/i)
})

test('lock do checkout bloqueia outra execução mesmo com outra pasta de estado e não é removido', async () => {
  const { rodarMissao } = await import('../codex/rodar.mjs')
  const { raiz, git } = projeto()
  const lock = join(git('rev-parse', '--absolute-git-dir'), 'missao-codex.lock')
  writeFileSync(lock, 'outro processo')
  await assert.rejects(rodarMissao({ projeto: raiz, args: argsMissao, pastaEstado: temp() }), /lock|execução/i)
  assert.equal(readFileSync(lock, 'utf8'), 'outro processo')
})

test('saída anormal do CLI preserva diagnóstico e lock para inspeção', async () => {
  const { rodarMissao } = await import('../codex/rodar.mjs')
  const { raiz, git } = projeto(), estado = temp()
  const caso = join(estado, 'cenario.json'); escrever(caso, { codigo: 9 })
  await assert.rejects(rodarMissao({ projeto: raiz, args: argsMissao, pastaEstado: estado, comando: [process.execPath, fixture, caso] }), /Codex|código/i)
  assert.ok(existsSync(join(git('rev-parse', '--absolute-git-dir'), 'missao-codex.lock')))
  const pasta = readdirSync(estado).find(x => x.startsWith('execucao-'))
  assert.equal(ler(join(estado, pasta, 'estado.json')).status, 'erro')
  assert.ok(!existsSync(join(estado, pasta, 'resultado.json')))
})

test('parallel aninhado não ocupa vaga e mantém ordem dos resultados', async () => {
  const { executarFluxo } = await import('../codex/rodar.mjs')
  const { agent } = await agenteFalso({ demoraMs: 70, resultado: { ok: true } }, { concorrencia: 1 })
  const fonte = `export const meta = {};
    return await parallel([() => parallel([() => agent('a', args), () => agent('b', args)]), () => agent('c', args)])`
  const r = await executarFluxo(fonte, { label: 'F1', phase: 'Implementar', schema }, { agent })
  assert.deepEqual(r, [[{ ok: true }, { ok: true }], { ok: true }])
})

test('parallel espera o irmão terminar antes de propagar erro', async () => {
  const { executarFluxo } = await import('../codex/rodar.mjs')
  let finalizado = false
  const agent = async nome => {
    if (nome === 'falha') throw new Error('fronteira falhou')
    await new Promise(r => setTimeout(r, 80))
    finalizado = true
    return { ok: true }
  }
  const fonte = `export const meta = {}; return await parallel([() => agent('falha'), () => agent('lento')])`
  await assert.rejects(executarFluxo(fonte, {}, { agent }), /fronteira falhou/)
  assert.equal(finalizado, true)
})
