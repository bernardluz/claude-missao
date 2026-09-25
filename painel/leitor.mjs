// Lê o que o Claude Code grava de cada execução do workflow missao e monta o estado das missões.
// Fonte: <raiz>/projects/<projeto>/<sessão>/subagents/workflows/wf_*/ com journal.jsonl (agentes iniciados, resultados
// e quedas, em ordem) e agent-<id>.jsonl (conversa de cada agente: prompt, horários, tokens).
// Somente leitura. Arquivos em escrita podem terminar com linha incompleta; ela é ignorada até completar.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

export const raizPadrao = () => process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')

// Com agente rodando, a execução só conta como parada depois deste tempo sem nenhum arquivo novo (uma chamada de
// ferramenta longa não escreve nada). Sem agente rodando, a missão lança o próximo na hora: poucos minutos parada
// já indicam que ela terminou ou parou.
export const SEM_SINAL_MS = 20 * 60 * 1000
export const OCIOSA_MS = 3 * 60 * 1000

const SUITE = 'Suíte final'

function subpastas(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(dir, d.name))
  } catch {
    return []
  }
}

// Leitura incremental: guarda o deslocamento e só processa bytes novos, cortando na última quebra de linha.
const cache = new Map()
function lerIncremental(arquivo, aoLer, chave = arquivo) {
  let st
  try {
    st = fs.statSync(arquivo)
  } catch {
    return cache.get(chave)?.estado ?? null
  }
  let c = cache.get(chave)
  if (!c || st.size < c.tamanho) c = { tamanho: 0, estado: aoLer(null, null) }
  if (st.size > c.tamanho) {
    let buf
    let fd
    try {
      fd = fs.openSync(arquivo, 'r')
      buf = Buffer.alloc(st.size - c.tamanho)
      buf = buf.subarray(0, fs.readSync(fd, buf, 0, buf.length, c.tamanho))
    } catch {
      buf = Buffer.alloc(0)
    } finally {
      if (fd !== undefined) fs.closeSync(fd)
    }
    const fim = buf.lastIndexOf(0x0a)
    if (fim >= 0) {
      for (const linha of buf.subarray(0, fim).toString('utf8').split('\n')) {
        if (!linha.trim()) continue
        let o
        try {
          o = JSON.parse(linha)
        } catch {
          continue
        }
        aoLer(c.estado, o)
      }
      c.tamanho += fim + 1
    }
  }
  c.estado.mtime = st.mtimeMs
  cache.set(chave, c)
  return c.estado
}

function textoDe(conteudo) {
  if (typeof conteudo === 'string') return conteudo
  if (Array.isArray(conteudo)) return conteudo.map(p => (typeof p === 'string' ? p : p?.text ?? '')).join('\n')
  return ''
}

const numero = v => (Number.isFinite(Number(v)) ? Number(v) : 0)

export function lerAgente(arquivo) {
  return lerIncremental(arquivo, (e, o) => {
    if (!e) return { inicio: null, fim: null, cwd: null, prompt: '', respondeu: false, uso: new Map(), modelo: null, effort: null, mtime: 0 }
    if (o.timestamp) {
      e.inicio ??= o.timestamp
      e.fim = o.timestamp
    }
    e.cwd ??= o.cwd ?? null
    // O harness pode mandar o pedido do usuário e a tarefa calculada em mensagens separadas: o prompt é tudo o que
    // chega antes da primeira resposta.
    if (o.type === 'assistant') {
      e.respondeu = true
      if (typeof o.message?.model === 'string') e.modelo = o.message.model
      if (typeof o.effort === 'string') e.effort = o.effort
    } else if (o.type === 'user' && !e.respondeu) e.prompt += textoDe(o.message?.content) + '\n'
    const u = o.message?.usage
    const id = o.message?.id
    if (u && id) {
      e.uso.set(id, {
        saida: numero(u.output_tokens),
        total: numero(u.input_tokens) + numero(u.output_tokens) +
          numero(u.cache_creation_input_tokens) + numero(u.cache_read_input_tokens),
      })
    }
  })
}

// Passos de um agente para a visão ao vivo: tarefa, textos, "pensou" (o conteúdo do raciocínio não é gravado),
// ferramentas com o essencial da entrada e resultados resumidos. Textos longos são cortados.
const CORTE = 4000
const cortar = (t, n = CORTE) => { const s = String(t ?? ''); return s.length > n ? `${s.slice(0, n)}
… (+${s.length - n} caracteres)` : s }
function resumoFerramenta(nome, e = {}) {
  if (nome === 'Bash' || nome === 'PowerShell') return { resumo: e.description || e.command, detalhe: e.command }
  if (['Read', 'Write', 'Edit', 'NotebookEdit'].includes(nome)) {
    const detalhe = nome === 'Edit' ? `- ${cortar(e.old_string, 1500)}
+ ${cortar(e.new_string, 1500)}` : nome === 'Write' ? cortar(e.content, 1500) : ''
    return { resumo: e.file_path, detalhe }
  }
  if (nome === 'Grep') return { resumo: `${e.pattern}${e.path ? ` em ${e.path}` : ''}`, detalhe: '' }
  if (nome === 'Glob') return { resumo: e.pattern, detalhe: '' }
  if (nome === 'StructuredOutput') return { resumo: 'resultado final', detalhe: cortar(JSON.stringify(e, null, 2)) }
  return { resumo: nome, detalhe: cortar(JSON.stringify(e, null, 2), 1500) }
}
export function lerPassos(arquivo) {
  return lerIncremental(arquivo, (e, o) => {
    if (!e) return { passos: [], respondeu: false, mtime: 0 }
    const c = o.message?.content
    const quando = o.timestamp ?? null
    if (o.type === 'user' && !e.respondeu) {
      const texto = textoDe(c)
      if (texto.trim()) e.passos.push({ tipo: 'tarefa', quando, texto: cortar(texto, 6000) })
      return
    }
    if (o.type === 'assistant') {
      e.respondeu = true
      for (const p of Array.isArray(c) ? c : []) {
        if (p.type === 'text' && p.text?.trim()) e.passos.push({ tipo: 'texto', quando, texto: cortar(p.text) })
        else if (p.type === 'thinking' && e.passos.at(-1)?.tipo !== 'pensou') e.passos.push({ tipo: 'pensou', quando })
        else if (p.type === 'tool_use') e.passos.push({ tipo: 'ferramenta', quando, id: p.id, nome: p.name, ...resumoFerramenta(p.name, p.input) })
      }
      return
    }
    if (o.type === 'user') {
      for (const p of Array.isArray(c) ? c : []) {
        if (p.type !== 'tool_result') continue
        const texto = typeof p.content === 'string' ? p.content : textoDe(p.content)
        e.passos.push({ tipo: 'resultado', quando, id: p.tool_use_id, erro: p.is_error === true, texto: cortar(texto) })
      }
    }
  }, `passos:${arquivo}`)
}

// Pasta de uma execução pelo id (wf_…). Só aceita o formato do id: nada de caminho.
const execucoesAchadas = new Map()
export function localizarExecucao(runId, raiz = raizPadrao()) {
  if (!/^wf_[A-Za-z0-9_-]{1,80}$/.test(runId)) return null
  const memo = execucoesAchadas.get(`${raiz}|${runId}`)
  if (memo && fs.existsSync(path.join(memo, 'journal.jsonl'))) return memo
  for (const projeto of subpastas(path.join(raiz, 'projects'))) {
    for (const sessao of subpastas(projeto)) {
      const dir = path.join(sessao, 'subagents', 'workflows', runId)
      if (fs.existsSync(path.join(dir, 'journal.jsonl'))) {
        execucoesAchadas.set(`${raiz}|${runId}`, dir)
        return dir
      }
    }
  }
  return null
}

function tokensDe(agente) {
  let total = 0
  let saida = 0
  for (const u of agente?.uso?.values() ?? []) {
    total += u.total
    saida += u.saida
  }
  return { total, saida }
}

// Chamadas de agente na ordem do journal. Resultado e queda ("failed") casam pelo agentId; sem ele, pela chamada
// mais recente da mesma chave ainda aberta (retentativa com o mesmo prompt repete a chave).
export function lerJournal(arquivo) {
  return lerIncremental(arquivo, (e, o) => {
    if (!e) return { chamadas: [], mtime: 0 }
    if (o.type === 'started') {
      e.chamadas.push({ chave: o.key, agentId: o.agentId, label: o.label ?? '', aberta: true, caiu: false, resultado: null })
      return
    }
    if (o.type !== 'result' && o.type !== 'failed') return
    const alvo = e.chamadas.findLast(c => c.aberta && o.agentId && c.agentId === o.agentId) ??
      e.chamadas.findLast(c => c.aberta && c.chave === o.key)
    if (!alvo) return
    alvo.aberta = false
    if (o.type === 'failed') alvo.caiu = true
    else alvo.resultado = o.result ?? null
  })
}

// Plano no prompt do agente de skills: "## <milestone> (critério: <texto>)" seguido de "- <título>: <spec>".
// Título pode ter dois-pontos. Com a lista de títulos das skills, só linhas que começam por um título conhecido são
// features (o resto é continuação de spec); sem ela, uma heurística separa título e spec.
export function extrairPlano(prompt, { exatos = [], estrito = false } = {}) {
  const milestones = []
  if (!prompt) return milestones
  const conhecidos = [...exatos].sort((a, b) => b.length - a.length)
  let atual = null
  for (const bruta of prompt.split('\n')) {
    const linha = bruta.trimStart()
    const i = linha.indexOf(' (critério: ')
    if (linha.startsWith('## ') && i > 3) {
      atual = { titulo: linha.slice(3, i), criterio: linha.slice(i + 12).trimEnd().replace(/\)$/, ''), features: [] }
      milestones.push(atual)
    } else if (atual && linha.startsWith('- ')) {
      const resto = linha.slice(2)
      const exato = conhecidos.find(t => resto.startsWith(t + ':') || resto === t)
      // Linha de feature é sempre "título: spec"; sem ": " é continuação de spec.
      if (exato) atual.features.push(exato)
      else if (!estrito && resto.includes(': ')) atual.features.push(tituloPorHeuristica(resto))
    }
  }
  return milestones
}

// Sem título conhecido: o último ": " seguido de maiúscula nos primeiros 80 caracteres separa título e spec.
function tituloPorHeuristica(resto) {
  let corte = -1
  for (let i = resto.indexOf(': '); i >= 0 && i < 80; i = resto.indexOf(': ', i + 1)) {
    if (/\p{Lu}/u.test(resto[i + 2] ?? '')) corte = i
  }
  if (corte < 0) corte = resto.indexOf(': ')
  return corte < 0 ? resto : resto.slice(0, corte)
}

const PREFIXOS = [['revisão: ', 'revisao'], ['commit: ', 'commit'], ['testes: ', 'testes']]
function classificar(label) {
  for (const [p, tipo] of PREFIXOS) if (label.startsWith(p)) return { tipo, alvo: label.slice(p.length) }
  const ajuste = label.match(/^(.*) · ajuste (\d+)$/)
  if (ajuste) return { tipo: 'ajuste', alvo: ajuste[1], rodada: Number(ajuste[2]) }
  const correcao = label.match(/^correção (\d+)\.(\d+) \((.*)\)$/)
  if (correcao) return { tipo: 'trabalho', alvo: label, correcao: { rodada: Number(correcao[1]), milestone: correcao[3] } }
  if (label === 'suíte completa') return { tipo: 'suite', alvo: SUITE }
  if (['preparo', 'skills da missão', 'contexto do plano', 'conferência'].includes(label)) return { tipo: label, alvo: null }
  return { tipo: 'trabalho', alvo: label }
}

// Missões novas leem o git por script: o resultado é { saida } com o JSON do git-estado.mjs. As antigas devolviam o
// objeto direto.
function estadoGit(resultado) {
  if (typeof resultado?.saida !== 'string') return resultado ?? null
  try {
    return JSON.parse(resultado.saida)
  } catch {
    return null
  }
}

export function lerExecucao(dir) {
  const journal = lerJournal(path.join(dir, 'journal.jsonl'))
  if (!journal) return null
  const labels = new Set(journal.chamadas.map(c => c.label))
  // Retomada direto na suíte final não tem agente de skills (não há feature a guiar).
  if (!labels.has('preparo') || !['skills da missão', 'contexto do plano', 'suíte completa'].some(l => labels.has(l))) return null
  let ultimaAtividade = journal.mtime
  let inicio = null
  let cwd = null
  const chamadas = journal.chamadas.map((c, ordem) => {
    const agente = lerAgente(path.join(dir, `agent-${c.agentId}.jsonl`))
    if (agente) {
      ultimaAtividade = Math.max(ultimaAtividade, agente.mtime)
      if (agente.inicio && (!inicio || agente.inicio < inicio)) inicio = agente.inicio
      cwd ??= agente.cwd
    }
    const duracaoMs = agente?.inicio && agente?.fim ? Date.parse(agente.fim) - Date.parse(agente.inicio) : 0
    return { ...c, ordem, ...classificar(c.label), inicio: agente?.inicio ?? null, duracaoMs, tokens: tokensDe(agente), modelo: agente?.modelo ?? null, effort: agente?.effort ?? null, agente }
  })
  // O agente "skills da missão" virou "contexto do plano" (áreas em vez de skills); as missões antigas seguem legíveis.
  const skillsChamada = chamadas.find(c => c.label === 'skills da missão' || c.label === 'contexto do plano')
  const skills = [skillsChamada?.resultado?.skills, skillsChamada?.resultado?.areas].find(Array.isArray) ?? []
  const daSkill = skills.flatMap(s => (Array.isArray(s.features) ? s.features : []))
  const exatos = new Set(daSkill)
  for (const c of chamadas) if (c.tipo === 'trabalho' && !c.correcao) exatos.add(c.alvo)
  const plano = extrairPlano(skillsChamada?.agente?.prompt, { exatos, estrito: daSkill.length > 0 })
  const preparo = estadoGit(chamadas.find(c => c.label === 'preparo')?.resultado)
  for (const c of chamadas) delete c.agente
  const inativo = Date.now() - ultimaAtividade
  const algumaAberta = chamadas.some(c => c.aberta)
  return {
    dir,
    runId: path.basename(dir),
    inicio,
    ultimaAtividade,
    viva: algumaAberta ? inativo < SEM_SINAL_MS : inativo < OCIOSA_MS,
    cwd: cwd ?? preparo?.raiz ?? null,
    preparo,
    skills: skills.map(s => ({ nome: String(s.nome ?? ''), features: Array.isArray(s.features) ? s.features : [], guia: String(s.guia ?? '') })),
    plano,
    chamadas,
  }
}

export function listarExecucoes(raiz = raizPadrao()) {
  const execucoes = []
  for (const projeto of subpastas(path.join(raiz, 'projects'))) {
    for (const sessao of subpastas(projeto)) {
      for (const wf of subpastas(path.join(sessao, 'subagents', 'workflows'))) {
        const e = lerExecucao(wf)
        if (e) execucoes.push({ ...e, sessao: path.basename(sessao) })
      }
    }
  }
  return execucoes
}

const idDe = chave => crypto.createHash('sha1').update(chave).digest('hex').slice(0, 12)
const concluiu = r => r.chamadas.filter(c => c.tipo === 'suite').at(-1)?.resultado?.aprovado === true
const mesmoRepo = (a, b) => (a.cwd ?? '').toLowerCase() === (b.cwd ?? '').toLowerCase()

// Uma retomada repete o fim do plano (mesmo último milestone) e recomeça num milestone ainda não validado. Plano que
// recomeça num milestone já validado, ou execução depois de uma missão concluída, abre outra missão. Retomada direto
// na suíte final (sem plano) entra na missão aberta mais recente do mesmo repositório.
export function agruparMissoes(execucoes) {
  const grupos = []
  for (const e of [...execucoes].sort((a, b) => (a.inicio ?? '').localeCompare(b.inicio ?? ''))) {
    const aberto = grupos.findLast(g => mesmoRepo(g.runs[0], e) && !concluiu(g.runs.at(-1)) &&
      (!e.plano.length || g.ultimoMilestone === e.plano.at(-1).titulo))
    const continua = aberto && (!e.plano.length || !aberto.validados.has(e.plano[0].titulo))
    if (continua) {
      aberto.runs.push(e)
    } else if (e.plano.length) {
      grupos.push({ runs: [e], ultimoMilestone: e.plano.at(-1).titulo, validados: new Set() })
    } else {
      continue
    }
    const g = continua ? aberto : grupos.at(-1)
    for (const m of validadosNa(e)) g.validados.add(m)
  }
  return grupos.map(g => montarMissao(idDe(`${g.runs[0].cwd}|${g.runs[0].runId}`), g.runs))
}

function validadosNa(execucao) {
  const ultimos = new Map()
  for (const c of execucao.chamadas) {
    if (c.tipo === 'testes' || c.tipo === 'revisao') ultimos.set(`${c.tipo}|${c.alvo}`, c)
  }
  const nomes = new Set([...ultimos.keys()].map(k => k.split('|').slice(1).join('|')))
  return [...nomes].filter(n => ultimos.get(`testes|${n}`)?.resultado?.aprovado && ultimos.get(`revisao|${n}`)?.resultado?.aprovado)
}

function montarMissao(id, runs) {
  const ultima = runs.at(-1)
  const milestones = []
  const porTitulo = new Map()
  for (const r of runs) {
    for (const m of r.plano) {
      if (porTitulo.has(m.titulo)) continue
      const novo = { titulo: m.titulo, criterio: m.criterio, features: m.features.map(t => ({ titulo: t })), correcoes: [], validacoes: [] }
      porTitulo.set(m.titulo, novo)
      milestones.push(novo)
    }
  }
  const suite = { titulo: SUITE, criterio: 'suíte completa do que a missão tocou e de quem depende disso', features: [], correcoes: [], validacoes: [], suite: true }
  porTitulo.set(SUITE, suite)
  milestones.push(suite)
  const milestoneDaFeature = new Map()
  for (const m of milestones) for (const f of m.features) milestoneDaFeature.set(f.titulo, m)

  // Rodadas de correção recomeçam em 1 a cada execução: a chave inclui a execução para não misturar as duas.
  const chaveCorrecao = (execucao, titulo) => `${execucao}#${titulo}`
  const chamadasPorAlvo = new Map()
  const linhaDoTempo = []
  for (const [indice, r] of runs.entries()) {
    const execucao = indice + 1
    for (const c of r.chamadas) {
      const chamada = { ...c, execucao, viva: r.viva, ref: `${r.runId}/${c.agentId}` }
      linhaDoTempo.push(chamada)
      if (c.tipo === 'testes' || (c.tipo === 'revisao' && porTitulo.has(c.alvo))) {
        porTitulo.get(c.alvo)?.validacoes.push(chamada)
        continue
      }
      if (c.tipo === 'suite') {
        suite.validacoes.push(chamada)
        continue
      }
      if (!c.alvo) continue
      if (c.correcao) {
        const m = porTitulo.get(c.correcao.milestone)
        const chave = chaveCorrecao(execucao, c.alvo)
        if (m && !m.correcoes.some(f => f.chave === chave)) m.correcoes.push({ titulo: c.alvo, chave, rodada: c.correcao.rodada, execucao })
      }
      const chave = c.alvo.startsWith('correção ') ? chaveCorrecao(execucao, c.alvo) : c.alvo
      if (!chamadasPorAlvo.has(chave)) chamadasPorAlvo.set(chave, [])
      chamadasPorAlvo.get(chave).push(chamada)
    }
  }

  const rodando = c => c.aberta && c.viva
  const estadoFeature = f => {
    const cs = chamadasPorAlvo.get(f.chave ?? f.titulo) ?? []
    const commit = cs.findLast(c => c.tipo === 'commit' && c.resultado?.commitado)
    const emCurso = cs.findLast(rodando)
    const trabalho = cs.findLast(c => (c.tipo === 'trabalho' || c.tipo === 'ajuste') && c.resultado)
    const revisao = cs.findLast(c => c.tipo === 'revisao' && c.resultado)
    let estado = 'pendente'
    if (commit) estado = 'feita'
    else if (emCurso || (cs.length && cs.at(-1).viva)) estado = 'rodando'
    else if (cs.length) estado = 'parou'
    return {
      titulo: f.titulo,
      rodada: f.rodada,
      execucao: f.execucao,
      estado,
      etapa: emCurso ? etapaCurta(emCurso) : null,
      commit: commit?.resultado?.commit ?? null,
      rodadasAjuste: cs.filter(c => c.tipo === 'ajuste').length,
      quedas: cs.filter(c => c.caiu).length,
      resumo: trabalho?.resultado?.resumo ?? null,
      jaResolvido: trabalho?.resultado?.jaResolvido === true,
      revisao: revisao ? { aprovado: !!revisao.resultado?.aprovado, problemas: Array.isArray(revisao.resultado?.problemas) ? revisao.resultado.problemas : [] } : null,
      motivoCommit: cs.findLast(c => c.tipo === 'commit' && c.resultado && !c.resultado.commitado)?.resultado?.motivo ?? null,
      duracaoMs: cs.reduce((s, c) => s + c.duracaoMs, 0),
      tokens: cs.reduce((s, c) => s + c.tokens.total, 0),
      agentes: cs.length,
      chamadas: cs.map(c => ({ ref: c.ref, label: c.label, tipo: c.tipo, rodada: c.rodada ?? null, inicio: c.inicio, duracaoMs: c.duracaoMs, estado: estadoChamada(c), modelo: c.modelo, effort: c.effort })),
      pipeline: pipelineDe(cs, !!commit),
    }
  }
  // Milestone validado encerra o que ficou sem commit registrado (feito à mão ou já resolvido).
  const encerrar = validado => f => validado && f.estado !== 'feita'
    ? { ...f, estado: 'feita', semCommitRegistrado: true, pipeline: f.pipeline.map(p => (p.estado === 'feita' ? p : { ...p, estado: 'pulada' })) }
    : f

  let feitas = 0
  let total = 0
  for (const m of milestones) {
    // Cada rodada roda testes e revisão juntos: vale a chamada mais recente de cada um, mesmo ainda sem resultado.
    const ultimaTestes = m.validacoes.findLast(c => c.tipo === 'testes')
    const ultimaRevisao = m.validacoes.findLast(c => c.tipo === 'revisao')
    const ultimaSuite = m.validacoes.findLast(c => c.tipo === 'suite')
    const validado = m.suite ? ultimaSuite?.resultado?.aprovado === true
      : ultimaTestes?.resultado?.aprovado === true && ultimaRevisao?.resultado?.aprovado === true
    m.features = m.features.map(estadoFeature).map(encerrar(validado))
    m.correcoes = m.correcoes.map(estadoFeature).map(encerrar(validado))
    const todos = [...m.features, ...m.correcoes]
    const comAtividade = todos.some(f => f.estado !== 'pendente') || m.validacoes.length > 0
    m.estado = validado ? 'validado'
      : m.validacoes.some(rodando) ? 'validando'
        : m.correcoes.some(f => f.estado === 'rodando') ? 'corrigindo'
          : todos.some(f => f.estado === 'rodando') ? 'rodando'
            : !comAtividade ? 'pendente'
              : ultima.viva ? 'rodando' : 'parou'
    m.rodadasCorrecao = m.correcoes.filter(f => f.execucao === runs.length).reduce((n, f) => Math.max(n, f.rodada ?? 0), 0)
    m.problemasValidacao = validado ? [] : [ultimaTestes, ultimaRevisao, ultimaSuite]
      .filter(c => c?.resultado && !c.resultado.aprovado)
      .flatMap(c => (Array.isArray(c.resultado.problemas) ? c.resultado.problemas : []).map(p => ({ origem: c.label, ...p })))
    m.validacoes = m.validacoes.map(c => ({
      label: c.label,
      estado: c.aberta ? (c.viva ? 'rodando' : 'interrompido') : c.caiu ? 'caiu' : c.resultado?.aprovado ? 'aprovado' : 'reprovado',
    }))
    if (!m.suite) {
      total += m.features.length
      feitas += m.features.filter(f => f.estado === 'feita').length
    }
  }

  const estado = suite.estado === 'validado' ? 'concluida' : ultima.viva ? 'rodando' : 'parada'
  const emCurso = linhaDoTempo.findLast(rodando)
  const featureAtual = milestones.flatMap(m => [...m.features, ...m.correcoes].map(f => ({ ...f, milestone: m.titulo }))).find(f => f.estado === 'rodando') ?? null
  const ultimaChamada = linhaDoTempo.at(-1)
  const preparo = runs[0].preparo
  return {
    id,
    projeto: path.basename(ultima.cwd ?? runs[0].cwd ?? '?'),
    cwd: ultima.cwd ?? runs[0].cwd,
    branch: preparo?.branch ?? null,
    base: preparo?.head ?? null,
    estado,
    progresso: { feitas, total },
    atual: emCurso ? rotuloEtapa(emCurso) : null,
    agora: emCurso ? { ref: emCurso.ref, label: emCurso.label, inicio: emCurso.inicio, etapa: rotuloEtapa(emCurso), modelo: emCurso.modelo, effort: emCurso.effort } : null,
    featureAtual: featureAtual ? { titulo: featureAtual.titulo, milestone: featureAtual.milestone, pipeline: featureAtual.pipeline } : null,
    ultimoEvento: ultimaChamada ? { label: ultimaChamada.label, resumo: resumoDe(ultimaChamada) } : null,
    inicio: runs[0].inicio,
    ultimaAtividade: Math.max(...runs.map(r => r.ultimaAtividade)),
    execucoes: runs.map(r => ({ runId: r.runId, sessao: r.sessao, inicio: r.inicio, viva: r.viva, agentes: r.chamadas.length })),
    tokens: linhaDoTempo.reduce((s, c) => s + c.tokens.total, 0),
    tokensSaida: linhaDoTempo.reduce((s, c) => s + c.tokens.saida, 0),
    agentes: linhaDoTempo.length,
    milestones,
    skills: ultima.skills.length ? ultima.skills : runs.findLast(r => r.skills.length)?.skills ?? [],
    linhaDoTempo: linhaDoTempo.slice(-40).reverse().map(c => ({
      ref: c.ref, label: c.label, modelo: c.modelo, effort: c.effort, execucao: c.execucao, inicio: c.inicio, duracaoMs: c.duracaoMs, tokens: c.tokens.total,
      estado: c.aberta ? (c.viva ? 'rodando' : 'interrompido') : c.caiu ? 'caiu' : 'ok', resumo: resumoDe(c),
    })),
  }
}

function estadoChamada(c) {
  return c.aberta ? (c.viva ? 'rodando' : 'interrompido') : c.caiu ? 'caiu' : 'ok'
}

// Etapas de uma feature: implementar → revisão → ajustes → commit, cada uma feita, agora, pendente ou pulada.
function pipelineDe(cs, commitado) {
  const de = tipo => cs.filter(c => c.tipo === tipo)
  const etapa = (nome, lista, pulada = false) => {
    const ultima = lista.at(-1)
    const estado = !ultima ? (pulada ? 'pulada' : 'pendente') : ultima.aberta ? (ultima.viva ? 'agora' : 'parou') : ultima.caiu ? 'parou' : 'feita'
    return { nome, estado, vezes: lista.length }
  }
  const revisoes = de('revisao')
  const aprovada = revisoes.at(-1)?.resultado?.aprovado === true
  const ajustes = de('ajuste')
  const passos = [etapa('Implementar', de('trabalho')), etapa('Revisão independente', revisoes), etapa('Ajustes', ajustes, aprovada && !ajustes.length), etapa('Commit atômico', de('commit'))]
  if (commitado) for (const p of passos) if (p.estado === 'pendente') p.estado = 'pulada'
  return passos
}

function etapaCurta(c) {
  if (c.tipo === 'revisao') return 'revisão'
  if (c.tipo === 'commit') return 'commit'
  if (c.tipo === 'ajuste') return `ajuste ${c.rodada}`
  return 'implementando'
}

function rotuloEtapa(c) {
  if (c.tipo === 'revisao') return `revisão de ${c.alvo}`
  if (c.tipo === 'commit') return `commit de ${c.alvo}`
  if (c.tipo === 'ajuste') return `ajuste ${c.rodada} de ${c.alvo}`
  if (c.tipo === 'testes') return `testes de ${c.alvo}`
  if (c.tipo === 'suite') return 'suíte completa'
  if (c.tipo === 'trabalho') return `implementando ${c.alvo}`
  return c.label
}

function resumoDe(c) {
  if (c.caiu) return 'agente caiu'
  const r = c.resultado
  if (c.aberta || !r || typeof r !== 'object') return null
  if ('commitado' in r) return r.commitado ? `commit ${String(r.commit ?? '').slice(0, 9)}` : `sem commit: ${r.motivo ?? ''}`
  if ('aprovado' in r) return r.aprovado ? 'aprovado' : `${Array.isArray(r.problemas) ? r.problemas.length : 0} apontamento(s)`
  if ('concluida' in r) return r.concluida ? 'concluída' : 'não concluída'
  if (Array.isArray(r.skills)) return `${r.skills.length} skills`
  if (Array.isArray(r.areas)) return `${r.areas.length} áreas`
  if (typeof r.saida === 'string') {
    const g = estadoGit(r)
    return g ? (g.limpo ? `árvore limpa em ${String(g.head ?? '').slice(0, 9)}` : 'árvore suja') : 'saída inválida'
  }
  if ('limpo' in r) return r.limpo ? `árvore limpa em ${String(r.head ?? '').slice(0, 9)}` : 'árvore suja'
  return null
}

// A base vem do resultado de um agente: só entra no git se for um SHA.
export function commitsDaMissao(missao) {
  if (!missao.cwd || !/^[0-9a-f]{7,40}$/i.test(missao.base ?? '')) return []
  try {
    const saida = execFileSync('git', ['-C', missao.cwd, 'log', '--format=%h%x09%cI%x09%s', '-n', '300', '--end-of-options', `${missao.base}..HEAD`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 })
    return saida.split('\n').filter(Boolean).map(l => {
      const [sha, data, ...assunto] = l.split('\t')
      return { sha, data, assunto: assunto.join('\t') }
    })
  } catch {
    return []
  }
}

export function missoes(raiz = raizPadrao()) {
  return agruparMissoes(listarExecucoes(raiz))
    .sort((a, b) => b.ultimaAtividade - a.ultimaAtividade)
}
