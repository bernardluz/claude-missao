import { readFileSync, writeFileSync, mkdirSync, realpathSync, renameSync, existsSync, unlinkSync, appendFileSync, lstatSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, dirname, basename } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { instalar } from '../instalar.mjs'
import { criarAgenteCodex } from './agente.mjs'

const FuncaoAssincrona = Object.getPrototypeOf(async function () {}).constructor
const json = p => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
const hash = s => createHash('sha256').update(s).digest('hex')
function gravar(p, valor) {
  const temporario = `${p}.${randomUUID()}.tmp`
  writeFileSync(temporario, JSON.stringify(valor, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  renameSync(temporario, p)
}
const dentro = (base, alvo) => { const r = relative(base, alvo); return r === '' || (!isAbsolute(r) && r !== '..' && !r.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) }

function destinoCanonico(caminho) {
  const partes = []
  let base = caminho
  while (!lstatSync(base, { throwIfNoEntry: false })) {
    partes.unshift(basename(base))
    const pai = dirname(base)
    if (pai === base) throw new Error('pasta de estado sem ancestral existente')
    base = pai
  }
  // realpath falha em link pendente: não criar nada por trás dele.
  return resolve(realpathSync(base), ...partes)
}
export async function executarFluxo(fonte, args, { agent, registrar = () => {} }) {
  // Mesmo contrato usado pelo simulador do núcleo. Fonte local instalada e verificada pelo runner.
  if (!fonte.replace(/^\uFEFF/, '').startsWith('export const meta')) throw new Error('workflow sem meta')
  const parallel = async tarefas => {
    const resultados = await Promise.allSettled(tarefas.map(t => Promise.resolve().then(t)))
    const erro = resultados.find(r => r.status === 'rejected')
    if (erro) throw erro.reason
    return resultados.map(r => r.value)
  }
  return new FuncaoAssincrona('agent', 'parallel', 'log', 'phase', 'args', fonte.replace('export const meta', 'const meta'))(
    agent, parallel, mensagem => registrar({ tipo: 'log', mensagem }), fase => registrar({ tipo: 'fase', fase }), args)
}

export async function rodarMissao({ projeto, args, retomar, pastaEstado, comando, modelo, aprovacao = 'never', concorrencia = 2, timeoutMs, signal, aoEvento = () => {} }) {
  if (!projeto || (!!args === !!retomar)) throw new Error('informe projeto e exatamente um de args ou retomar')
  projeto = realpathSync(projeto)
  const git = (...a) => execFileSync('git', ['-C', projeto, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  if (realpathSync(git('rev-parse', '--show-toplevel')) !== projeto) throw new Error('projeto deve ser a raiz do checkout')
  const verificado = instalar(projeto, { verificar: true })
  if (!verificado.atualizado) throw new Error('workflow instalado ausente, adulterado ou desatualizado; revise e rode instalar.mjs <projeto> antes')
  const fonte = readFileSync(verificado.destino, 'utf8').replace(/^\uFEFF/, '')
  const workflowHash = hash(fonte)
  if (retomar) {
    const salvo = json(retomar)
    if (salvo.versao !== 1 || salvo.projeto !== projeto || salvo.workflowHash !== workflowHash || !salvo.resultado?.retomar || !salvo.args) throw new Error('retomada inválida: resultado normal, projeto e hash do workflow devem coincidir')
    args = { ...salvo.args, retomar: salvo.resultado.retomar }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('args deve ser um objeto JSON')
  pastaEstado = resolve(pastaEstado ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'missoes'))
  // Resolver o ancestral existente antes de mkdir: alias/junction não pode criar estado no checkout.
  pastaEstado = destinoCanonico(pastaEstado)
  if (dentro(projeto, pastaEstado)) throw new Error('registros da missão devem ficar fora do repositório')
  mkdirSync(pastaEstado, { recursive: true, mode: 0o700 })
  pastaEstado = realpathSync(pastaEstado)
  if (dentro(projeto, pastaEstado)) throw new Error('registros da missão devem ficar fora do repositório')
  const lock = join(git('rev-parse', '--absolute-git-dir'), 'missao-codex.lock')
  const dono = JSON.stringify({ pid: process.pid, id: randomUUID(), projeto })
  try { writeFileSync(lock, dono, { flag: 'wx', mode: 0o600 }) } catch (e) {
    if (e.code === 'EEXIST') throw new Error(`checkout já tem execução/lock: ${lock}; inspecione antes de removê-lo`)
    throw e
  }
  let pasta, agent, intervencaoManual = false
  const estado = { versao: 1, projeto, workflowHash, status: 'rodando', fase: null, inicio: new Date().toISOString() }
  try {
    pasta = join(pastaEstado, `execucao-${randomUUID()}`)
    mkdirSync(pasta, { mode: 0o700 })
    gravar(join(pasta, 'entrada.json'), { args, modelo: modelo ?? null, aprovacao, concorrencia })
    const registrar = evento => {
      appendFileSync(join(pasta, 'eventos.jsonl'), JSON.stringify({ instante: new Date().toISOString(), ...evento }) + '\n', { mode: 0o600 })
      if (evento.tipo === 'fase') { estado.fase = evento.fase; gravar(join(pasta, 'estado.json'), estado) }
      aoEvento(evento)
    }
    gravar(join(pasta, 'estado.json'), estado)
    agent = criarAgenteCodex({ projeto, registros: join(pasta, 'agentes'), comando, modelo, aprovacao, concorrencia, timeoutMs, signal, registrar })
    const resultado = await executarFluxo(fonte, args, { agent, registrar })
    await agent.encerrar()
    const arquivoResultado = join(pasta, 'resultado.json')
    gravar(arquivoResultado, { versao: 1, projeto, workflowHash, args, resultado })
    estado.status = resultado?.concluido === true ? 'concluida' : 'parada'
    estado.fim = new Date().toISOString()
    gravar(join(pasta, 'estado.json'), estado)
    return { resultado, arquivoResultado, pasta }
  } catch (e) {
    intervencaoManual = !!e.intervencaoManual
    const drenagem = await agent?.encerrar()
    intervencaoManual ||= !!drenagem?.intervencaoManual
    if (pasta) {
      estado.status = 'erro'; estado.erro = e.message; estado.intervencaoManual = intervencaoManual; estado.fim = new Date().toISOString()
      gravar(join(pasta, 'estado.json'), estado)
    }
    throw e
  } finally {
    const drenagem = await agent?.encerrar()
    intervencaoManual ||= !!drenagem?.intervencaoManual
    if (!intervencaoManual && existsSync(lock) && readFileSync(lock, 'utf8') === dono) unlinkSync(lock)
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { values: v } = parseArgs({ args: argv, options: {
    projeto: { type: 'string' }, args: { type: 'string' }, retomar: { type: 'string' }, estado: { type: 'string' },
    modelo: { type: 'string' }, aprovacao: { type: 'string', default: 'never' }, concorrencia: { type: 'string', default: '2' },
    'timeout-ms': { type: 'string', default: '1800000' }, help: { type: 'boolean' },
  } })
  if (v.help) {
    console.log('node codex/rodar.mjs --projeto <raiz> (--args <JSON> | --retomar <resultado.json>) [--estado <pasta fora do repo>] [--modelo <modelo>] [--aprovacao never|auto] [--concorrencia 1..6] [--timeout-ms 1800000]')
    return 0
  }
  if (!v.projeto || (!!v.args === !!v.retomar)) throw new Error('informe --projeto e exatamente um de --args ou --retomar')
  const controller = new AbortController()
  const cancelar = () => controller.abort()
  process.once('SIGINT', cancelar); process.once('SIGTERM', cancelar)
  try {
    const r = await rodarMissao({ projeto: v.projeto, args: v.args ? json(v.args) : undefined, retomar: v.retomar,
      pastaEstado: v.estado, modelo: v.modelo, aprovacao: v.aprovacao, concorrencia: Number(v.concorrencia), timeoutMs: Number(v['timeout-ms']), signal: controller.signal,
      aoEvento: e => { if (e.tipo === 'fase') console.log(`fase: ${e.fase}`) },
    })
    console.log(`resultado: ${r.arquivoResultado}`)
    return r.resultado?.concluido === true ? 0 : 2
  } finally { process.removeListener('SIGINT', cancelar); process.removeListener('SIGTERM', cancelar) }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(codigo => { process.exitCode = codigo }, erro => { console.error(`erro: ${erro.message}`); process.exitCode = 1 })
}
