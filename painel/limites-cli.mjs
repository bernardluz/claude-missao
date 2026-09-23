// Atualiza os limites da assinatura sem depender de sessão aberta no terminal: roda o `claude` CLI em modo não
// interativo com o mínimo possível (Haiku, sem ferramentas, sem MCP, sem settings nem hooks do usuário, sem salvar
// sessão, prompt curto) e lê o evento `rate_limit_event` da saída stream-json. Custa cerca de 850 tokens por consulta.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { arquivoLimites, gravarLimites } from './statusline.mjs'

const ARGS = [
  '-p', 'ok', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--max-turns', '1',
  '--tools', '', '--no-session-persistence', '--strict-mcp-config', '--setting-sources', '',
  '--system-prompt', 'Responda apenas: ok',
]

// Piso do intervalo: consulta gasta uso da própria assinatura. Falha seguida dobra a espera, até ESPERA_MAX_MS.
export const INTERVALO_MIN_MINUTOS = 5
const ESPERA_MAX_MS = 60 * 60 * 1000

const janela = j => j && Number.isFinite(Number(j.utilization))
  ? { usado: Math.round(Number(j.utilization) * 1000) / 10, zeraEm: Number.isFinite(Number(j.resetsAt)) ? Number(j.resetsAt) * 1000 : null }
  : null

// Saída stream-json (uma linha JSON por evento) → limites no formato da statusline, ou null.
export function limitesDaSaida(texto) {
  let evento = null
  for (const linha of String(texto).split('\n')) {
    try {
      const o = JSON.parse(linha)
      if (o?.type === 'rate_limit_event') evento = o
    } catch {}
  }
  const w = evento?.rate_limit_info?.unifiedWindows
  if (!w) return null
  const limites = { cincoHoras: janela(w.five_hour), semanal: janela(w.seven_day) }
  return limites.cincoHoras || limites.semanal ? limites : null
}

// Caminho absoluto pelo PATH: no Windows, sem isso a busca olha antes a pasta de trabalho.
export function acharExecutavel(nome = 'claude', caminhos = process.env.PATH ?? '') {
  // No Windows só o .exe roda sem shell (um shim sem extensão, do npm, falharia no spawn).
  const exts = process.platform === 'win32' ? ['.exe'] : ['']
  for (const dir of caminhos.split(path.delimiter).filter(d => d && path.isAbsolute(d) && !d.includes('"'))) {
    for (const ext of exts) {
      const alvo = path.join(dir, nome + ext)
      try {
        if (fs.statSync(alvo).isFile()) return alvo
      } catch {}
    }
  }
  return null
}

// Pasta vazia como diretório de trabalho: o CLI não carrega CLAUDE.md nem configuração de projeto.
function pastaVazia() {
  const dir = path.join(os.tmpdir(), 'missao-painel-vazio')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function consultarPeloCli({ comando = acharExecutavel(), timeoutMs = 60_000 } = {}) {
  return new Promise(resolve => {
    if (!comando) return resolve(null)
    let saida = ''
    let feito = false
    const terminar = valor => {
      if (feito) return
      feito = true
      clearTimeout(limite)
      resolve(valor)
    }
    let filho
    try {
      filho = spawn(comando, ARGS, { cwd: pastaVazia(), stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      return resolve(null)
    }
    // Resolve no próprio timeout: um neto que herde o stdout não deixa a consulta presa para sempre.
    const limite = setTimeout(() => {
      try {
        filho.kill()
      } catch {}
      terminar(limitesDaSaida(saida))
    }, timeoutMs)
    filho.stdout.on('data', d => { saida += d })
    filho.on('error', () => terminar(null))
    filho.on('close', () => terminar(limitesDaSaida(saida)))
  })
}

// Consulta pelo CLI quando a última leitura (statusline ou CLI) passou do intervalo e a última tentativa também.
// Tentativa sem resultado conta: a próxima espera o dobro, até 1 h. Nunca duas consultas ao mesmo tempo.
// `minutos` 0 (ou inválido) desliga; abaixo do piso vira o piso.
export function agendarLimites({ raiz, minutos, consultar = consultarPeloCli, agora = () => Date.now(), checarACadaMs = 60_000 }) {
  if (!(minutos > 0)) return () => {}
  const intervalo = Math.max(minutos, INTERVALO_MIN_MINUTOS) * 60 * 1000
  let rodando = false
  let ultimaTentativa = 0
  let falhas = 0
  const tentar = async () => {
    if (rodando) return
    let lidoEm = 0
    try {
      lidoEm = Number(JSON.parse(fs.readFileSync(arquivoLimites(raiz), 'utf8')).lidoEm) || 0
    } catch {}
    const espera = Math.min(intervalo * 2 ** falhas, ESPERA_MAX_MS)
    if (agora() - lidoEm < intervalo || agora() - ultimaTentativa < espera) return
    rodando = true
    ultimaTentativa = agora()
    try {
      const limites = await consultar()
      if (limites) {
        gravarLimites(limites, arquivoLimites(raiz))
        falhas = 0
      } else {
        falhas++
      }
    } catch {
      falhas++
    } finally {
      rodando = false
    }
  }
  tentar()
  const t = setInterval(tentar, checarACadaMs)
  t.unref?.()
  return () => clearInterval(t)
}
