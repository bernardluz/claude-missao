import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, delimiter } from 'node:path'
import { homedir } from 'node:os'
import { schemaEstrito, normalizarResultado } from './schema.mjs'

const dentro = (base, alvo) => { const r = relative(base, alvo); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) }
const somenteLeitura = o => ['preparo', 'conferência', 'simplicidade', 'planejar', 'contexto do plano'].includes(o.label) || /^(revisão:|contrato:|telas:|áreas de caça:)/.test(o.label)
function executavelCodex(projeto) {
  const nome = process.platform === 'win32' ? 'codex.exe' : 'codex'
  for (const pasta of (process.env.PATH ?? '').split(delimiter)) {
    if (!pasta || !isAbsolute(pasta) || dentro(projeto, resolve(pasta))) continue
    const arquivo = join(pasta, nome)
    if (existsSync(arquivo)) return realpathSync(arquivo)
  }
  throw new Error('Codex CLI não encontrado no PATH; instale o CLI ou forneça um executável absoluto')
}
function papelDoProjeto(projeto, tipo, home) {
  if (!tipo) return ''
  if (!/^[a-zA-Z0-9_-]+$/.test(tipo)) throw new Error('nome de papel inválido')
  for (const base of [join(projeto, '.codex', 'agents'), join(projeto, '.claude', 'agents'), join(home, '.codex', 'agents'), join(home, '.claude', 'agents')]) {
    const arquivo = join(base, `${tipo}.md`)
    if (!existsSync(arquivo)) continue
    if (!dentro(realpathSync(base), realpathSync(arquivo))) throw new Error('papel fora da pasta de agentes')
    return readFileSync(arquivo, 'utf8').replace(/^\uFEFF/, '').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
  }
  throw new Error(`papel de agente ausente: ${tipo}`)
}
const manual = erro => Object.assign(erro, { intervencaoManual: true })

// stdout/stderr são arquivos: shells/builds não mantêm um pipe do runner aberto.
function processo(comando, argumentos, prompt, pasta, timeoutMs, signal) {
  return new Promise((resolveP, reject) => {
    let child, timer, grace, terminou = false, forçado = null
    const out = openSync(join(pasta, 'stdout.jsonl'), 'wx', 0o600)
    const err = openSync(join(pasta, 'stderr.log'), 'wx', 0o600)
    const finalizar = (erro, codigo) => {
      if (terminou) return
      terminou = true
      clearTimeout(timer); clearTimeout(grace)
      signal?.removeEventListener('abort', cancelar)
      if (erro) reject(erro); else resolveP(codigo)
    }
    const parar = motivo => {
      if (terminou || forçado) return
      forçado = manual(new Error(motivo))
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        if (process.platform === 'win32') {
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, shell: false })
          killer.on('error', () => { try { child.kill('SIGKILL') } catch {} })
        } else {
          try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
        }
      }
      // A interrupção não prova ausência de netos destacados: o lock será conservado.
      grace = setTimeout(() => finalizar(forçado), 3000)
    }
    const cancelar = () => parar('execução Codex cancelada; inspecione processos antes de liberar o lock')
    try {
      child = spawn(comando[0], [...comando.slice(1), ...argumentos], {
        cwd: argumentos[argumentos.indexOf('--cd') + 1], stdio: ['pipe', out, err], shell: false,
        windowsHide: true, detached: process.platform !== 'win32',
      })
    } catch (e) { closeSync(out); closeSync(err); finalizar(e); return }
    closeSync(out); closeSync(err)
    child.once('error', e => finalizar(new Error(`Codex não iniciou: ${e.message}`)))
    child.once('exit', (codigo, sig) => finalizar(forçado ?? (codigo !== 0 ? manual(new Error(`Codex terminou com código ${codigo ?? sig}; logs em ${pasta}`)) : null), codigo))
    child.stdin.on('error', () => {}) // EPIPE é diagnosticado pelo exit/error do processo.
    child.stdin.end(prompt)
    timer = setTimeout(() => parar(`tempo limite (timeout) do Codex: ${timeoutMs} ms; logs em ${pasta}`), timeoutMs)
    signal?.addEventListener('abort', cancelar, { once: true })
    if (signal?.aborted) cancelar()
  })
}

export function exigirModelo(modelo) {
  if (typeof modelo !== 'string' || !modelo.trim()) {
    throw new Error('Qual modelo você quer usar nesta missão? Informe a escolha do usuário em --modelo <modelo>.')
  }
  return modelo.trim()
}

export function criarAgenteCodex({ projeto, registros, comando, modelo, aprovacao = 'never', concorrencia = 2, timeoutMs = 30 * 60_000, home = homedir(), signal, registrar = () => {} }) {
  modelo = exigirModelo(modelo)
  projeto = realpathSync(projeto)
  if (!['never', 'auto'].includes(aprovacao)) throw new Error('aprovação inválida; use never ou auto')
  if (!Number.isInteger(concorrencia) || concorrencia < 1 || concorrencia > 6) throw new Error('concorrência deve estar entre 1 e 6')
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('timeout deve ser inteiro positivo')
  comando ??= [executavelCodex(projeto)]
  if (!Array.isArray(comando) || !comando.length || !isAbsolute(comando[0]) || comando.some(x => typeof x !== 'string')) throw new Error('executável Codex deve ser caminho absoluto')
  mkdirSync(registros, { recursive: true, mode: 0o700 })
  let contador = 0, ativos = 0, fatal = null, intervencaoManual = false
  const fila = [], pendentes = new Set()
  function vaga() {
    if (fatal || signal?.aborted) return Promise.reject(fatal ?? new Error('execução cancelada'))
    if (ativos < concorrencia) { ativos++; return Promise.resolve() }
    return new Promise((ok, erro) => fila.push({ ok, erro }))
  }
  function liberar() {
    ativos--
    if (fatal || signal?.aborted) { while (fila.length) fila.shift().erro(fatal ?? new Error('execução cancelada')); return }
    if (fila.length) { ativos++; fila.shift().ok() }
  }
  async function executar(prompt, opcoes) {
    await vaga()
    try {
      if (typeof prompt !== 'string' || !opcoes || typeof opcoes.label !== 'string' || !opcoes.schema) throw new Error('chamada de agente inválida')
      const papel = papelDoProjeto(projeto, opcoes.agentType, home)
      const pasta = join(registros, `agente-${String(++contador).padStart(4, '0')}`)
      mkdirSync(pasta, { mode: 0o700 })
      const resultadoPath = join(pasta, 'resposta.json'), schemaPath = join(pasta, 'schema.json')
      const schema = { type: 'object', additionalProperties: false, properties: {
        bloqueado: { type: 'boolean' }, motivo: { type: 'string' },
        resultado: { anyOf: [schemaEstrito(opcoes.schema), { type: 'null' }] },
      }, required: ['bloqueado', 'motivo', 'resultado'] }
      writeFileSync(schemaPath, JSON.stringify(schema), { flag: 'wx', mode: 0o600 })
      writeFileSync(join(pasta, 'pedido.json'), JSON.stringify({ prompt, opcoes }), { flag: 'wx', mode: 0o600 })
      const sandbox = somenteLeitura(opcoes) ? 'read-only' : 'workspace-write'
      const auto = aprovacao === 'auto' && sandbox === 'workspace-write'
      const argv = ['--no-daemon', ...(auto ? [] : ['--ask-for-approval', 'never']), 'exec',
        ...(auto ? ['--approve-for-me'] : []), '--sandbox', sandbox, '--cd', projeto, '--ephemeral',
        '--json', '--color', 'never', '--output-schema', schemaPath, '--output-last-message', resultadoPath,
        '--model', modelo, '-']
      const briefing = 'Você executa um passo de um workflow controlado. Respeite AGENTS.md e as permissões; não crie outros agentes. ' +
        'Não faça push/deploy nem altere configurações globais. Não está sozinho no checkout: preserve trabalho alheio. ' +
        'Se houver recusa de permissão, pare sem contornar e devolva bloqueado=true, motivo e resultado=null. ' +
        'Se completar, devolva bloqueado=false, motivo="" e resultado no schema solicitado. Campos opcionais não usados são null. ' +
        'Use Bash se a tarefa exigir um comando Bash literal; não reinterprete o comando em outro shell.\n\n' +
        (papel ? `Papel de leitura do projeto (metadados Claude não definem modelo/permissões):\n${papel}\n\n` : '') + prompt
      registrar({ tipo: 'agente-inicio', label: opcoes.label, sandbox, pasta })
      await processo(comando, argv, briefing, pasta, timeoutMs, signal)
      let r
      try { r = JSON.parse(readFileSync(resultadoPath, 'utf8').replace(/^\uFEFF/, '')) } catch { throw manual(new Error(`resposta JSON do Codex ausente ou inválida: ${resultadoPath}`)) }
      if (!r || typeof r !== 'object' || Array.isArray(r) || Object.keys(r).length !== 3 || !Object.hasOwn(r, 'resultado') || typeof r.bloqueado !== 'boolean' || typeof r.motivo !== 'string') throw manual(new Error('envelope de resposta fora do contrato'))
      if (r.bloqueado) throw new Error(`agente bloqueado (${opcoes.label}): ${r.motivo}`)
      let resultado
      try { resultado = normalizarResultado(r.resultado, opcoes.schema) } catch (e) { throw manual(e) }
      registrar({ tipo: 'agente-fim', label: opcoes.label, pasta })
      return resultado
    } catch (e) { fatal ??= e; intervencaoManual ||= !!e.intervencaoManual; throw e } finally { liberar() }
  }
  const agent = (prompt, opcoes) => {
    const p = executar(prompt, opcoes)
    pendentes.add(p)
    p.then(() => pendentes.delete(p), () => pendentes.delete(p))
    return p
  }
  agent.encerrar = async () => { await Promise.allSettled([...pendentes]); return { intervencaoManual } }
  return agent
}
