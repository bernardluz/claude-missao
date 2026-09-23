// Painel local das missões: `npm run painel` e abra http://127.0.0.1:4610 (porta em PAINEL_PORTA).
// Só escuta em 127.0.0.1 e só lê arquivos: os registros do Claude Code e o `git log` do repositório da missão.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { missoes, commitsDaMissao, raizPadrao, lerPassos, localizarExecucao } from './leitor.mjs'
import { arquivoLimites } from './statusline.mjs'
import { agendarLimites, INTERVALO_MIN_MINUTOS } from './limites-cli.mjs'

const PAGINA = path.join(path.dirname(fileURLToPath(import.meta.url)), 'pagina.html')

// Limites da assinatura gravados pela statusline (painel/statusline.mjs). null quando ainda não há leitura.
function lerLimites(raiz) {
  try {
    const l = JSON.parse(fs.readFileSync(arquivoLimites(raiz), 'utf8'))
    return l && typeof l === 'object' ? l : null
  } catch {
    return null
  }
}

const resumo = m => {
  const { milestones, skills, linhaDoTempo, ...resto } = m
  const atual = milestones.find(x => !['validado', 'pendente'].includes(x.estado)) ?? null
  return { ...resto, milestoneAtual: atual?.titulo ?? null, milestones: milestones.map(x => ({ titulo: x.titulo, estado: x.estado })) }
}

function responder(res, status, corpo, tipo = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': tipo, 'cache-control': 'no-store' })
  res.end(typeof corpo === 'string' ? corpo : JSON.stringify(corpo))
}

export function criarServidor({ raiz = raizPadrao(), porta }) {
  // Várias abas atualizando juntas não refazem a varredura mais de uma vez a cada 2 s.
  let memo = { em: 0, dados: [] }
  const atuais = () => {
    if (Date.now() - memo.em > 2000) memo = { em: Date.now(), dados: missoes(raiz) }
    return memo.dados
  }
  // Recusa Host estranho: sem isso, um site com DNS rebinding para 127.0.0.1 conseguiria ler o painel.
  const hosts = new Set([`127.0.0.1:${porta}`, `localhost:${porta}`])
  return http.createServer((req, res) => {
    try {
      if (!hosts.has(String(req.headers.host ?? '').toLowerCase())) return responder(res, 421, { erro: 'host não permitido' })
      if (req.method !== 'GET') return responder(res, 405, { erro: 'somente leitura' })
      const url = new URL(req.url, 'http://localhost')
      if (url.pathname === '/') return responder(res, 200, fs.readFileSync(PAGINA, 'utf8'), 'text/html; charset=utf-8')
      if (url.pathname === '/api/missoes') return responder(res, 200, atuais().map(resumo))
      if (url.pathname === '/api/limites') return responder(res, 200, { limites: lerLimites(raiz) })
      const passos = url.pathname.match(/^\/api\/passos\/(wf_[A-Za-z0-9_-]{1,80})\/(a[0-9a-f]{6,40})$/)
      if (passos) {
        const dir = localizarExecucao(passos[1], raiz)
        const lidos = dir && lerPassos(path.join(dir, `agent-${passos[2]}.jsonl`))
        if (!lidos) return responder(res, 404, { erro: 'agente não encontrado' })
        const desde = Math.max(0, Math.floor(Number(url.searchParams.get('desde')) || 0))
        return responder(res, 200, { total: lidos.passos.length, desde, passos: lidos.passos.slice(desde), atualizadoEm: lidos.mtime })
      }
      const detalhe = url.pathname.match(/^\/api\/missoes\/([0-9a-f]{12})$/)
      if (detalhe) {
        const m = atuais().find(x => x.id === detalhe[1])
        if (!m) return responder(res, 404, { erro: 'missão não encontrada' })
        return responder(res, 200, { ...m, commits: commitsDaMissao(m) })
      }
      return responder(res, 404, { erro: 'não encontrado' })
    } catch (e) {
      return responder(res, 500, { erro: String(e?.message ?? e) })
    }
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const porta = Number(process.env.PAINEL_PORTA ?? 4610)
  const raiz = raizPadrao()
  // Limites da assinatura pelo claude CLI a cada PAINEL_LIMITES_MIN minutos (padrão 10; 0 desliga).
  const minutos = Number(process.env.PAINEL_LIMITES_MIN ?? 10)
  criarServidor({ raiz, porta }).listen(porta, '127.0.0.1', () => {
    console.log(`Painel das missões em http://127.0.0.1:${porta} (lendo ${raiz})`)
    if (minutos > 0) console.log(`Limites da assinatura: consulta pelo claude CLI a cada ${Math.max(minutos, INTERVALO_MIN_MINUTOS)} min`)
    agendarLimites({ raiz, minutos })
  })
}
