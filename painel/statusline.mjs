// Statusline do Claude Code que guarda os limites da assinatura para o painel.
// O Claude Code manda um JSON no stdin a cada atualização da statusline. Quando ele traz `rate_limits` (janela de
// 5 horas e semanal), o script grava esse trecho em <raiz>/missao-painel/limites.json e imprime a linha de status.
// Nunca falha: erro de leitura ou gravação só deixa de atualizar o arquivo.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const arquivoLimites = (raiz = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude')) =>
  path.join(raiz, 'missao-painel', 'limites.json')

const numeroValido = v => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '')) && Number.isFinite(Number(v))
const janela = j => j && numeroValido(j.used_percentage)
  ? { usado: Number(j.used_percentage), zeraEm: numeroValido(j.resets_at) ? Number(j.resets_at) * 1000 : null }
  : null

export function extrairLimites(entrada) {
  const r = entrada?.rate_limits
  if (!r || typeof r !== 'object') return null
  const limites = { cincoHoras: janela(r.five_hour), semanal: janela(r.seven_day) }
  return limites.cincoHoras || limites.semanal ? limites : null
}

// Várias sessões gravam o mesmo arquivo, cada uma com o rate_limits da sua última resposta. Na mesma janela (mesmo
// reset), o uso só cresce: fica o maior. Janela ausente na leitura nova mantém a anterior enquanto ela não zerou.
export function mesclarLimites(anterior, novo, agora = Date.now()) {
  const uma = (a, n) => {
    if (!n) return a && a.zeraEm && a.zeraEm > agora ? a : null
    if (a && a.zeraEm === n.zeraEm && Number(a.usado) > n.usado) return { ...n, usado: Number(a.usado) }
    return n
  }
  return { cincoHoras: uma(anterior?.cincoHoras, novo.cincoHoras), semanal: uma(anterior?.semanal, novo.semanal) }
}

function lerAnterior(arquivo) {
  try {
    return JSON.parse(fs.readFileSync(arquivo, 'utf8'))
  } catch {
    return null
  }
}

// Gravação atômica: o painel nunca lê um arquivo pela metade. Falha apaga o temporário.
export function gravarLimites(limites, arquivo = arquivoLimites(), agora = Date.now()) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true })
  const tmp = `${arquivo}.${process.pid}.tmp`
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...mesclarLimites(lerAnterior(arquivo), limites, agora), lidoEm: agora }))
    fs.renameSync(tmp, arquivo)
  } catch (e) {
    try {
      fs.unlinkSync(tmp)
    } catch {}
    throw e
  }
}

export function linhaDeStatus(entrada, limites) {
  const partes = [entrada?.model?.display_name]
  if (limites?.cincoHoras) partes.push(`5h ${Math.round(limites.cincoHoras.usado)}%`)
  if (limites?.semanal) partes.push(`semana ${Math.round(limites.semanal.usado)}%`)
  return partes.filter(Boolean).join(' · ')
}

async function principal() {
  let texto = ''
  for await (const pedaco of process.stdin) texto += pedaco
  let entrada = null
  try {
    entrada = JSON.parse(texto)
  } catch {}
  const limites = extrairLimites(entrada)
  if (limites) {
    try {
      gravarLimites(limites)
    } catch {}
  }
  process.stdout.write(linhaDeStatus(entrada, limites))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) principal()
