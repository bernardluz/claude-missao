import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extrairPlano, missoes } from '../painel/leitor.mjs'
import { criarServidor } from '../painel/servidor.mjs'

const PLANO = [
  '[Workflow harness — computed task] texto do harness',
  '  ## M1 base (critério: testes passam (todos))',
  '  - F1 Admin: base e Contas: Crie a feature: com tela.',
  '  - F2 lista: Liste itens.',
  '    - item de continuação da spec',
  '  ## M2 final (critério: suíte ok)',
  '  - F3 fim: Termine.',
].join('\n')
const PLANO_M2 = PLANO.split('\n').slice(0, 1).concat(PLANO.split('\n').slice(5)).join('\n')

const CAIU = Symbol('caiu')
const MIN = 60 * 1000

// Execução falsa. Cada chamada é [label, resultado]: undefined = rodando, CAIU = agente caiu.
// `idadeMs` é quanto tempo faz desde a última escrita nos arquivos.
function execucao(raiz, runId, chamadas, { sessao = 's1', cwd = 'C:/repo/proj', head = 'aaaaaaa1', idadeMs = 0, inicioMin = 0, plano = PLANO } = {}) {
  const dir = join(raiz, 'projects', 'C--repo-proj', sessao, 'subagents', 'workflows', runId)
  mkdirSync(dir, { recursive: true })
  const linhas = [{ type: 'launched' }]
  const arquivos = ['journal.jsonl']
  chamadas.forEach(([label, resultado], i) => {
    const agentId = `${runId}-${i}`
    const key = `k-${label}`
    linhas.push({ type: 'started', key, agentId, label, phase: '▸ missao' })
    const t0 = new Date(Date.UTC(2026, 8, 23, 1, inicioMin + i)).toISOString()
    const t1 = new Date(Date.UTC(2026, 8, 23, 1, inicioMin + i, 30)).toISOString()
    arquivos.push(`agent-${agentId}.jsonl`)
    writeFileSync(join(dir, `agent-${agentId}.jsonl`), [
      { type: 'user', timestamp: t0, cwd, message: { content: label === 'skills da missão' ? plano : `tarefa ${label}` } },
      { type: 'assistant', timestamp: t1, message: { id: `m${i}`, usage: { input_tokens: 10, output_tokens: 5 } } },
    ].map(o => JSON.stringify(o)).join('\n') + '\n')
    if (resultado === CAIU) linhas.push({ type: 'failed', key, agentId })
    else if (resultado !== undefined) {
      linhas.push({ type: 'result', key, agentId, result: label === 'preparo' ? { limpo: true, branch: 'develop', head, raiz: cwd } : resultado })
    }
  })
  writeFileSync(join(dir, 'journal.jsonl'), linhas.map(o => JSON.stringify(o)).join('\n') + '\n')
  if (idadeMs) {
    const t = new Date(Date.now() - idadeMs)
    for (const f of arquivos) utimesSync(join(dir, f), t, t)
  }
  return dir
}

const SKILLS = { skills: [{ nome: 'Telas', features: ['F1 Admin: base e Contas', 'F2 lista'], guia: 'g' }, { nome: 'Fim', features: ['F3 fim'], guia: 'g' }] }
const ok = { aprovado: true, problemas: [] }
const reprovado = p => ({ aprovado: false, problemas: [{ problema: p }] })
const feita = sha => ({ commitado: true, commit: sha })
const inicio = [['preparo', {}], ['skills da missão', SKILLS]]
const f1Feita = [['F1 Admin: base e Contas', { concluida: true }], ['revisão: F1 Admin: base e Contas', ok], ['commit: F1 Admin: base e Contas', feita('1111111')]]
const f2Feita = [['F2 lista', { concluida: true }], ['revisão: F2 lista', ok], ['commit: F2 lista', feita('2222222')]]
const f3Feita = [['F3 fim', { concluida: true }], ['revisão: F3 fim', ok], ['commit: F3 fim', feita('3333333')]]
const temp = () => mkdtempSync(join(tmpdir(), 'painel-'))

test('plano: título com dois-pontos vem dos títulos das skills e continuação de spec é ignorada', () => {
  const plano = extrairPlano(PLANO, { exatos: ['F1 Admin: base e Contas', 'F2 lista', 'F3 fim'], estrito: true })
  assert.deepEqual(plano.map(m => m.titulo), ['M1 base', 'M2 final'])
  assert.equal(plano[0].criterio, 'testes passam (todos)')
  assert.deepEqual(plano[0].features, ['F1 Admin: base e Contas', 'F2 lista'])
  assert.deepEqual(plano[1].features, ['F3 fim'])
})

test('plano sem skills usa o último ": " seguido de maiúscula', () => {
  const plano = extrairPlano('## M (critério: x)\n- F9 Admin: A pagar e receber: Tela de contas: com filtro.')
  assert.deepEqual(plano[0].features, ['F9 Admin: A pagar e receber'])
})

test('plano ignora "## " sem critério (spec em várias linhas)', () => {
  assert.deepEqual(extrairPlano('## M (critério: x)\n- F1 a: B\n## Notas da spec\n- F2 b: C').map(m => m.titulo), ['M'])
})

test('estado por feature, milestone e missão rodando', () => {
  const raiz = temp()
  execucao(raiz, 'wf_1', [
    ...inicio,
    ['F1 Admin: base e Contas', { concluida: true, resumo: 'feito' }],
    ['revisão: F1 Admin: base e Contas', reprovado('falta teste')],
    ['F1 Admin: base e Contas · ajuste 1', { concluida: true, resumo: 'ajustado' }],
    ['revisão: F1 Admin: base e Contas', ok],
    ['commit: F1 Admin: base e Contas', feita('abc1234')],
    ['F2 lista', undefined],
  ])
  const [m] = missoes(raiz)
  assert.equal(m.estado, 'rodando')
  assert.deepEqual(m.progresso, { feitas: 1, total: 3 })
  const [f1, f2] = m.milestones[0].features
  assert.equal(f1.estado, 'feita')
  assert.equal(f1.commit, 'abc1234')
  assert.equal(f1.rodadasAjuste, 1)
  assert.equal(f2.estado, 'rodando')
  assert.equal(f2.etapa, 'implementando')
  assert.equal(m.milestones[0].estado, 'rodando')
  assert.equal(m.milestones[1].estado, 'pendente')
  assert.equal(m.atual, 'implementando F2 lista')
  assert.equal(m.milestones.at(-1).titulo, 'Suíte final')
})

test('linha incompleta no fim do journal é ignorada até completar', () => {
  const raiz = temp()
  const dir = execucao(raiz, 'wf_1', [...inicio, ['F1 Admin: base e Contas', undefined]])
  appendFileSync(join(dir, 'journal.jsonl'), '{"type":"result","key":"k-F1 Admin: base e Co')
  assert.equal(missoes(raiz)[0].milestones[0].features[0].estado, 'rodando')
})

test('agente que caiu não conta como rodando; a etapa é a da retentativa', () => {
  const raiz = temp()
  execucao(raiz, 'wf_1', [
    ...inicio,
    ['F1 Admin: base e Contas', { concluida: true }],
    ['revisão: F1 Admin: base e Contas', CAIU],
    ['revisão: F1 Admin: base e Contas', undefined],
  ])
  const f1 = missoes(raiz)[0].milestones[0].features[0]
  assert.equal(f1.estado, 'rodando')
  assert.equal(f1.etapa, 'revisão')
  assert.equal(f1.quedas, 1)
})

test('sem agente rodando e sem atividade há minutos, a missão está parada', () => {
  const raiz = temp()
  execucao(raiz, 'wf_1', [...inicio, ['F1 Admin: base e Contas', { concluida: false }]], { idadeMs: 5 * MIN })
  const [m] = missoes(raiz)
  assert.equal(m.estado, 'parada')
  assert.equal(m.milestones[0].features[0].estado, 'parou')
  assert.equal(m.milestones[0].estado, 'parou')
})

test('agente rodando sem escrever por menos de 20 min ainda conta como rodando', () => {
  const raiz = temp()
  execucao(raiz, 'wf_1', [...inicio, ['F1 Admin: base e Contas', undefined]], { idadeMs: 10 * MIN })
  assert.equal(missoes(raiz)[0].estado, 'rodando')
})

test('milestone só é validado quando a rodada mais recente aprova testes e revisão', () => {
  const raiz = temp()
  execucao(raiz, 'wf_1', [
    ...inicio, ...f1Feita, ...f2Feita,
    ['testes: M1 base', reprovado('teste X')], ['revisão: M1 base', ok],
    ['correção 1.1 (M1 base)', { concluida: true }], ['revisão: correção 1.1 (M1 base)', ok], ['commit: correção 1.1 (M1 base)', feita('ccccccc')],
    ['testes: M1 base', ok], ['revisão: M1 base', undefined],
  ])
  const m1 = missoes(raiz)[0].milestones[0]
  assert.equal(m1.estado, 'validando')
  assert.equal(m1.correcoes[0].estado, 'feita')
})

test('correções do milestone aparecem com rodada e problemas da validação reprovada', () => {
  const raiz = temp()
  execucao(raiz, 'wf_1', [
    ...inicio, ...f1Feita, ...f2Feita,
    ['testes: M1 base', reprovado('teste X falha')], ['revisão: M1 base', ok],
    ['correção 1.1 (M1 base)', undefined],
  ])
  const m1 = missoes(raiz)[0].milestones[0]
  assert.equal(m1.estado, 'corrigindo')
  assert.equal(m1.rodadasCorrecao, 1)
  assert.equal(m1.correcoes[0].estado, 'rodando')
  assert.equal(m1.problemasValidacao[0].problema, 'teste X falha')
})

test('a mesma correção em duas execuções fica separada', () => {
  const raiz = temp()
  execucao(raiz, 'wf_1', [
    ...inicio, ...f1Feita, ...f2Feita,
    ['testes: M1 base', reprovado('x')], ['revisão: M1 base', ok],
    ['correção 1.1 (M1 base)', { concluida: true }], ['revisão: correção 1.1 (M1 base)', ok], ['commit: correção 1.1 (M1 base)', feita('ccccccc')],
    ['testes: M1 base', reprovado('y')], ['revisão: M1 base', ok],
  ], { idadeMs: 3 * 60 * MIN })
  execucao(raiz, 'wf_2', [
    ...inicio, ['conferência', {}],
    ['testes: M1 base', reprovado('y')], ['revisão: M1 base', ok],
    ['correção 1.1 (M1 base)', undefined],
  ], { sessao: 's2', head: 'bbbbbbb2', inicioMin: 30 })
  const [m] = missoes(raiz)
  assert.equal(m.execucoes.length, 2)
  const m1 = m.milestones[0]
  assert.equal(m1.correcoes.length, 2)
  assert.deepEqual(m1.correcoes.map(c => [c.execucao, c.estado]), [[1, 'feita'], [2, 'rodando']])
  assert.equal(m1.estado, 'corrigindo')
})

test('retomada junta as execuções e milestone validado conclui feature sem commit registrado', () => {
  const raiz = temp()
  execucao(raiz, 'wf_1', [...inicio, ...f1Feita, ['F2 lista', { concluida: false }]], { idadeMs: 3 * 60 * MIN, head: 'base0001' })
  execucao(raiz, 'wf_2', [
    ...inicio, ['conferência', {}],
    ['testes: M1 base', ok], ['revisão: M1 base', ok], ...f3Feita,
    ['testes: M2 final', ok], ['revisão: M2 final', ok], ['suíte completa', ok],
  ], { sessao: 's2', head: 'head0002', inicioMin: 30 })
  const ms = missoes(raiz)
  assert.equal(ms.length, 1)
  const [m] = ms
  assert.equal(m.execucoes.length, 2)
  assert.equal(m.estado, 'concluida')
  assert.equal(m.base, 'base0001')
  const f2 = m.milestones[0].features[1]
  assert.equal(f2.estado, 'feita')
  assert.equal(f2.semCommitRegistrado, true)
  assert.deepEqual(m.progresso, { feitas: 3, total: 3 })
})

test('retomada direto na suíte final (sem agente de skills) entra na mesma missão', () => {
  const raiz = temp()
  execucao(raiz, 'wf_1', [
    ...inicio, ...f1Feita, ...f2Feita, ['testes: M1 base', ok], ['revisão: M1 base', ok],
    ...f3Feita, ['testes: M2 final', ok], ['revisão: M2 final', ok], ['suíte completa', reprovado('falha')],
  ], { idadeMs: 3 * 60 * MIN })
  execucao(raiz, 'wf_2', [['preparo', {}], ['conferência', {}], ['suíte completa', ok]], { sessao: 's2', head: 'ccccccc3', inicioMin: 30 })
  const ms = missoes(raiz)
  assert.equal(ms.length, 1)
  assert.equal(ms[0].execucoes.length, 2)
  assert.equal(ms[0].estado, 'concluida')
})

test('plano refeito a partir de milestone já validado abre outra missão', () => {
  const raiz = temp()
  execucao(raiz, 'wf_1', [...inicio, ...f1Feita, ...f2Feita, ['testes: M1 base', ok], ['revisão: M1 base', ok]], { idadeMs: 3 * 60 * MIN })
  execucao(raiz, 'wf_2', [...inicio, ['F1 Admin: base e Contas', undefined]], { sessao: 's2', inicioMin: 30 })
  const ms = missoes(raiz)
  assert.equal(ms.length, 2)
  assert.equal(ms[0].milestones[0].features[0].estado, 'rodando')
})

test('retomada sem commit (mesmo HEAD) continua na mesma missão', () => {
  const raiz = temp()
  execucao(raiz, 'wf_1', [...inicio, ['F1 Admin: base e Contas', { concluida: false }]], { idadeMs: 3 * 60 * MIN, head: 'mesmo001' })
  execucao(raiz, 'wf_2', [...inicio, ['F1 Admin: base e Contas', undefined]], { sessao: 's2', head: 'mesmo001', inicioMin: 30 })
  assert.equal(missoes(raiz).length, 1)
})

test('retomada de M2 em diante junta ao plano completo da primeira execução', () => {
  const raiz = temp()
  execucao(raiz, 'wf_1', [...inicio, ...f1Feita, ...f2Feita, ['testes: M1 base', ok], ['revisão: M1 base', CAIU]], { idadeMs: 3 * 60 * MIN })
  execucao(raiz, 'wf_2', [['preparo', {}], ['skills da missão', { skills: [{ nome: 'Fim', features: ['F3 fim'] }] }], ['F3 fim', undefined]],
    { sessao: 's2', inicioMin: 30, plano: PLANO_M2 })
  const ms = missoes(raiz)
  assert.equal(ms.length, 1)
  assert.deepEqual(ms[0].milestones.map(m => m.titulo), ['M1 base', 'M2 final', 'Suíte final'])
})

test('sem resultado do agente de skills, a heurística mantém o total de features', () => {
  const raiz = temp()
  execucao(raiz, 'wf_1', [['preparo', {}], ['skills da missão', CAIU], ['F1 Admin: base e Contas', undefined]])
  assert.equal(missoes(raiz)[0].progresso.total, 3)
})

test('workflow que não é missão fica de fora', () => {
  const raiz = temp()
  execucao(raiz, 'wf_1', [['outro agente', { x: 1 }]])
  assert.deepEqual(missoes(raiz), [])
})

test('servidor: recusa Host estranho e método que não é GET, e serve a lista', async () => {
  const raiz = temp()
  execucao(raiz, 'wf_1', [...inicio, ['F1 Admin: base e Contas', undefined]])
  const servidor = criarServidor({ raiz, porta: 0 })
  await new Promise(r => servidor.listen(0, '127.0.0.1', r))
  const porta = servidor.address().port
  // O Host precisa bater com a porta real do servidor.
  const outro = criarServidor({ raiz, porta })
  await new Promise(r => servidor.close(r))
  await new Promise(r => outro.listen(porta, '127.0.0.1', r))
  try {
    const url = `http://127.0.0.1:${porta}`
    assert.equal((await fetch(`${url}/api/missoes`)).status, 200)
    assert.equal((await fetch(`${url}/api/missoes`, { method: 'POST' })).status, 405)
    assert.equal((await fetch(`${url}/api/missoes/..%2F..%2Fetc`)).status, 404)
    const lista = await (await fetch(`${url}/api/missoes`)).json()
    assert.equal(lista.length, 1)
    assert.equal((await fetch(`${url}/api/missoes/${lista[0].id}`)).status, 200)
    const http = await import('node:http')
    const status = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: porta, path: '/api/missoes', headers: { host: `evil.example:${porta}` } }, r => {
        r.resume()
        resolve(r.statusCode)
      }).on('error', reject)
    })
    assert.equal(status, 421)
  } finally {
    await new Promise(r => outro.close(r))
  }
})

test('statusline grava os limites da assinatura e imprime a linha', async () => {
  const { spawnSync } = await import('node:child_process')
  const { readFileSync, existsSync } = await import('node:fs')
  const raiz = temp()
  const entrada = {
    model: { display_name: 'Opus 5.5' },
    rate_limits: { five_hour: { used_percentage: 19.4, resets_at: 1790000000 }, seven_day: { used_percentage: 66, resets_at: 1790400000 } },
  }
  const r = spawnSync(process.execPath, ['painel/statusline.mjs'], { input: JSON.stringify(entrada), env: { ...process.env, CLAUDE_CONFIG_DIR: raiz }, encoding: 'utf8' })
  assert.equal(r.status, 0)
  assert.equal(r.stdout, 'Opus 5.5 · 5h 19% · semana 66%')
  const gravado = JSON.parse(readFileSync(join(raiz, 'missao-painel', 'limites.json'), 'utf8'))
  assert.deepEqual(gravado.cincoHoras, { usado: 19.4, zeraEm: 1790000000000 })
  assert.equal(gravado.semanal.usado, 66)
  assert.ok(gravado.lidoEm > 0)

  // Sem rate_limits (ex.: antes da primeira resposta) não apaga a leitura anterior; entrada inválida não quebra.
  const sem = spawnSync(process.execPath, ['painel/statusline.mjs'], { input: JSON.stringify({ model: { display_name: 'Opus 5.5' } }), env: { ...process.env, CLAUDE_CONFIG_DIR: raiz }, encoding: 'utf8' })
  assert.equal(sem.stdout, 'Opus 5.5')
  assert.equal(JSON.parse(readFileSync(join(raiz, 'missao-painel', 'limites.json'), 'utf8')).semanal.usado, 66)
  const lixo = spawnSync(process.execPath, ['painel/statusline.mjs'], { input: 'não é json', env: { ...process.env, CLAUDE_CONFIG_DIR: raiz }, encoding: 'utf8' })
  assert.equal(lixo.status, 0)
  assert.ok(existsSync(join(raiz, 'missao-painel', 'limites.json')))
})

test('servidor: /api/limites devolve a última leitura ou null', async () => {
  const { gravarLimites, arquivoLimites } = await import('../painel/statusline.mjs')
  const raiz = temp()
  const servidor = criarServidor({ raiz, porta: 0 })
  await new Promise(r => servidor.listen(0, '127.0.0.1', r))
  const porta = servidor.address().port
  await new Promise(r => servidor.close(r))
  const s = criarServidor({ raiz, porta })
  await new Promise(r => s.listen(porta, '127.0.0.1', r))
  try {
    const url = `http://127.0.0.1:${porta}/api/limites`
    assert.deepEqual(await (await fetch(url)).json(), { limites: null })
    gravarLimites({ cincoHoras: { usado: 10, zeraEm: 1 }, semanal: null }, arquivoLimites(raiz), 123)
    assert.deepEqual(await (await fetch(url)).json(), { limites: { cincoHoras: { usado: 10, zeraEm: 1 }, semanal: null, lidoEm: 123 } })
  } finally {
    await new Promise(r => s.close(r))
  }
})

test('limites: sessões em paralelo não baixam o uso da mesma janela e valor nulo é descartado', async () => {
  const { mesclarLimites, extrairLimites } = await import('../painel/statusline.mjs')
  const agora = 1000
  const anterior = { cincoHoras: { usado: 40, zeraEm: 5000 }, semanal: { usado: 70, zeraEm: 9000 } }
  // Sessão parada grava valor antigo da mesma janela: fica o maior.
  assert.deepEqual(mesclarLimites(anterior, { cincoHoras: { usado: 30, zeraEm: 5000 }, semanal: null }, agora),
    { cincoHoras: { usado: 40, zeraEm: 5000 }, semanal: { usado: 70, zeraEm: 9000 } })
  // Janela nova (outro reset) substitui; janela ausente que já zerou some.
  assert.deepEqual(mesclarLimites(anterior, { cincoHoras: { usado: 2, zeraEm: 8000 }, semanal: null }, 9500),
    { cincoHoras: { usado: 2, zeraEm: 8000 }, semanal: null })
  assert.equal(extrairLimites({ rate_limits: { five_hour: { used_percentage: null, resets_at: 1 } } }), null)
  assert.equal(extrairLimites({ rate_limits: { five_hour: { used_percentage: '', resets_at: 1 } } }), null)
})

test('limites pelo CLI: lê o rate_limit_event do stream-json', async () => {
  const { limitesDaSaida } = await import('../painel/limites-cli.mjs')
  const saida = [
    '{"type":"system","subtype":"init"}',
    'linha quebrada {',
    '{"type":"rate_limit_event","rate_limit_info":{"unifiedWindows":{"five_hour":{"utilization":0.2,"resetsAt":1790191800},"seven_day":{"utilization":0.66,"resetsAt":1790586000}}}}',
    '{"type":"result","subtype":"success"}',
  ].join('\n')
  assert.deepEqual(limitesDaSaida(saida), { cincoHoras: { usado: 20, zeraEm: 1790191800000 }, semanal: { usado: 66, zeraEm: 1790586000000 } })
  assert.equal(limitesDaSaida('{"type":"result"}'), null)
  assert.equal(limitesDaSaida(''), null)
})

test('limites pelo CLI: agenda consulta só quando a leitura está velha e grava o resultado', async () => {
  const { agendarLimites } = await import('../painel/limites-cli.mjs')
  const { gravarLimites, arquivoLimites } = await import('../painel/statusline.mjs')
  const { readFileSync } = await import('node:fs')
  const raiz = temp()
  let chamadas = 0
  const consultar = async () => { chamadas++; return { cincoHoras: { usado: 30, zeraEm: Date.now() + 3600e3 }, semanal: null } }
  let parar = agendarLimites({ raiz, minutos: 10, consultar })
  await new Promise(r => setTimeout(r, 50))
  parar()
  assert.equal(chamadas, 1)
  assert.equal(JSON.parse(readFileSync(arquivoLimites(raiz), 'utf8')).cincoHoras.usado, 30)
  // Leitura recente (ex.: statusline): não consulta de novo.
  gravarLimites({ cincoHoras: { usado: 31, zeraEm: Date.now() + 3600e3 }, semanal: null }, arquivoLimites(raiz))
  parar = agendarLimites({ raiz, minutos: 10, consultar })
  await new Promise(r => setTimeout(r, 50))
  parar()
  assert.equal(chamadas, 1)
  assert.equal(agendarLimites({ raiz, minutos: 0, consultar })(), undefined)
})

test('limites pelo CLI: intervalo abaixo do piso não dispara consultas em rajada', async () => {
  const { agendarLimites } = await import('../painel/limites-cli.mjs')
  const raiz = temp()
  let chamadas = 0
  const parar = agendarLimites({ raiz, minutos: 0.001, consultar: async () => { chamadas++; return null }, checarACadaMs: 5 })
  await new Promise(r => setTimeout(r, 120))
  parar()
  assert.equal(chamadas, 1)
})

test('limites pelo CLI: falha seguida dobra a espera e sucesso volta ao intervalo', async () => {
  const { agendarLimites } = await import('../painel/limites-cli.mjs')
  const raiz = temp()
  const MINUTO = 60 * 1000
  let relogio = 1e12
  const respostas = [null, null, { cincoHoras: { usado: 10, zeraEm: 2e12 }, semanal: null }]
  const quando = []
  const consultar = async () => { quando.push(relogio); return respostas.shift() ?? null }
  const parar = agendarLimites({ raiz, minutos: 10, consultar, agora: () => relogio, checarACadaMs: 2 })
  const esperar = () => new Promise(r => setTimeout(r, 25))
  await esperar()
  relogio += 19 * MINUTO; await esperar()   // 1ª falha: espera 20 min, ainda não
  relogio += 1 * MINUTO; await esperar()    // 20 min: 2ª tentativa
  relogio += 39 * MINUTO; await esperar()   // 2ª falha: espera 40 min, ainda não
  relogio += 1 * MINUTO; await esperar()    // 40 min: 3ª tentativa, sucesso
  relogio += 9 * MINUTO; await esperar()    // leitura nova tem 9 min: não consulta
  parar()
  assert.deepEqual(quando.map(t => (t - 1e12) / MINUTO), [0, 20, 60])
})

test('limites pelo CLI: acha o executável pelo PATH, ignorando a pasta de trabalho', async () => {
  const { acharExecutavel } = await import('../painel/limites-cli.mjs')
  const dir = temp()
  const nome = process.platform === 'win32' ? 'claude.exe' : 'claude'
  writeFileSync(join(dir, nome), '')
  assert.equal(acharExecutavel('claude', dir), join(dir, nome))
  assert.equal(acharExecutavel('claude', ''), null)
})

test('passos ao vivo: tarefa, pensamento, ferramenta com resultado e texto, incremental', async () => {
  const { lerPassos } = await import('../painel/leitor.mjs')
  const dir = temp()
  const arquivo = join(dir, 'agent-a1234567.jsonl')
  const linhas = [
    { type: 'user', timestamp: 't0', message: { content: 'Implemente a feature' } },
    { type: 'assistant', timestamp: 't1', message: { content: [{ type: 'thinking', thinking: '' }, { type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'mvnw test', description: 'Roda os testes' } }] } },
    { type: 'user', timestamp: 't2', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'BUILD SUCCESS' }] } },
    { type: 'attachment', timestamp: 't2' },
  ]
  writeFileSync(arquivo, linhas.map(o => JSON.stringify(o)).join('\n') + '\n')
  let p = lerPassos(arquivo).passos
  assert.deepEqual(p.map(x => x.tipo), ['tarefa', 'pensou', 'ferramenta', 'resultado'])
  assert.equal(p[2].resumo, 'Roda os testes')
  assert.equal(p[2].detalhe, 'mvnw test')
  assert.equal(p[3].texto, 'BUILD SUCCESS')
  appendFileSync(arquivo, JSON.stringify({ type: 'assistant', timestamp: 't3', message: { content: [
    { type: 'tool_use', id: 'u2', name: 'Edit', input: { file_path: 'a.kt', old_string: 'x', new_string: 'y' } },
    { type: 'text', text: 'Pronto.' },
  ] } }) + '\n')
  p = lerPassos(arquivo).passos
  assert.equal(p.length, 6)
  assert.equal(p[4].resumo, 'a.kt')
  assert.match(p[4].detalhe, /^- x\n\+ y$/)
  assert.equal(p[5].texto, 'Pronto.')
})

test('servidor: /api/passos devolve passos a partir de desde e recusa id inválido', async () => {
  const raiz = temp()
  const dir = join(raiz, 'projects', 'p', 's', 'subagents', 'workflows', 'wf_abc-1')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'journal.jsonl'), '')
  writeFileSync(join(dir, 'agent-abcdef12.jsonl'), [
    { type: 'user', message: { content: 'tarefa' } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'oi' }] } },
  ].map(o => JSON.stringify(o)).join('\n') + '\n')
  const s0 = criarServidor({ raiz, porta: 0 })
  await new Promise(r => s0.listen(0, '127.0.0.1', r))
  const porta = s0.address().port
  await new Promise(r => s0.close(r))
  const s = criarServidor({ raiz, porta })
  await new Promise(r => s.listen(porta, '127.0.0.1', r))
  try {
    const base = `http://127.0.0.1:${porta}/api/passos`
    const tudo = await (await fetch(`${base}/wf_abc-1/abcdef12`)).json()
    assert.equal(tudo.total, 2)
    const depois = await (await fetch(`${base}/wf_abc-1/abcdef12?desde=1`)).json()
    assert.deepEqual(depois.passos.map(x => x.texto), ['oi'])
    assert.equal((await fetch(`${base}/wf_abc-1/..%2Fx`)).status, 404)
    assert.equal((await fetch(`${base}/wf_nao-existe/abcdef12`)).status, 404)
  } finally {
    await new Promise(r => s.close(r))
  }
})

test('pipeline: commit que caiu fica parou, não feita', () => {
  const raiz = temp()
  execucao(raiz, 'wf_1', [
    ...inicio, ['F1 Admin: base e Contas', { concluida: true }], ['revisão: F1 Admin: base e Contas', ok],
    ['commit: F1 Admin: base e Contas', CAIU],
  ], { idadeMs: 5 * MIN })
  const p = missoes(raiz)[0].milestones[0].features[0].pipeline
  assert.deepEqual(p.map(x => x.estado), ['feita', 'feita', 'pulada', 'parou'])
})
