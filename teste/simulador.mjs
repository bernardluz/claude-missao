// Executa o workflow com agentes falsos e um git simulado, sem chamar modelo nenhum.
// O script do Workflow roda como corpo de função assíncrona com agent/parallel/log/phase/args injetados.
import { readFileSync } from 'node:fs'

const FuncaoAssincrona = Object.getPrototypeOf(async function () {}).constructor

export function carregar(caminho) {
  return readFileSync(caminho, 'utf8').replace('export const meta', 'const meta')
}

const problemas = (n, prefixo) => Array.from({ length: n }, (_, i) => ({ problema: `${prefixo}${i}` }))

// opcoes:
//   raiz               raiz do repositório simulado
//   arquivos           caminhos que o worker declara (padrão ['x/a.js'])
//   arquivosGit        o que o git lista no diff (padrão = arquivos)
//   revisaoFeature     { [feature]: [n problemas por rodada] }
//   validacao          [n problemas por rodada de validação do milestone] (lidos pelo revisor do milestone)
//   gate               { [feature]: vezes que o gate falha }
//   foraDaLista        { [feature]: vezes que o commit acusa mudança fora da lista }
//   quedas             { [label]: vezes que o agente devolve null }
//   efeitoDaQueda      { [label]: 'commita' | 'suja' | 'commitaOrfao' }
//   semArquivos        worker não declara arquivos
//   jaResolvidoCorrecao correções voltam jaResolvido
//   branchNaConferencia branch devolvida pela conferência (simula troca de branch)
export async function executar(fonte, args, opcoes = {}, estado = { git: ['base0000'], sujo: false }) {
  const o = opcoes
  const quedas = { ...(o.quedas ?? {}) }
  const revisaoFeature = Object.fromEntries(Object.entries(o.revisaoFeature ?? {}).map(([k, v]) => [k, [...v]]))
  const gate = { ...(o.gate ?? {}) }
  const fora = { ...(o.foraDaLista ?? {}) }
  const raiz = o.raiz ?? 'C:/repo'
  const arquivos = o.arquivos ?? ['x/a.js']
  const arquivosGit = o.arquivosGit ?? arquivos
  let rodadaValidacao = 0
  const chamadas = []
  const logs = []
  const novoSha = () => `sha${String(estado.git.length).padStart(5, '0')}`

  const agent = async (prompt, opt) => {
    chamadas.push({ label: opt.label, phase: opt.phase, agentType: opt.agentType, prompt })
    const l = opt.label
    if (quedas[l] > 0) {
      quedas[l]--
      const efeito = o.efeitoDaQueda?.[l]
      if (efeito === 'commita') { estado.git.push(novoSha()); estado.sujo = false }
      if (efeito === 'suja') estado.sujo = true
      if (efeito === 'commitaOrfao') estado.git.push('orfao000')
      return null
    }
    if (l === 'preparo') return { limpo: !estado.sujo, branch: 'develop', head: estado.git.at(-1), raiz }
    if (l === 'skills da missão') return { skills: o.skills ?? [] }
    if (l === 'conferência') {
      const base = prompt.match(/rev-list --reverse (\w+)\.\.HEAD/)[1]
      const commits = estado.git.slice(estado.git.indexOf(base) + 1)
      return { branch: o.branchNaConferencia ?? 'develop', head: estado.git.at(-1), limpo: !estado.sujo, commits, arquivos: commits.length ? arquivosGit : [] }
    }
    if (opt.phase === 'Validar') {
      if (l.startsWith('testes: ')) return { aprovado: true, problemas: [] }
      const n = (o.validacao ?? [])[rodadaValidacao++] ?? 0
      return { aprovado: n === 0, problemas: problemas(n, 'v') }
    }
    if (l.startsWith('revisão: ')) {
      const n = (revisaoFeature[l.slice(9)] ?? []).shift() ?? 0
      return { aprovado: n === 0, problemas: problemas(n, 'r') }
    }
    if (l.startsWith('commit: ')) {
      const f = l.slice(8)
      if (fora[f] > 0) { fora[f]--; return { commitado: false, foraDaLista: ['y/b.js'] } }
      if (gate[f] > 0) { gate[f]--; return { commitado: false, gateFalhou: true, motivo: 'lint' } }
      if (!estado.sujo) return { commitado: false, motivo: 'nada a commitar' }
      const sha = novoSha()
      estado.git.push(sha)
      estado.sujo = false
      return { commitado: true, commit: sha }
    }
    // worker, ajuste ou correção
    if (o.jaResolvidoCorrecao && opt.phase === 'Corrigir' && !l.includes('ajuste')) {
      return { concluida: true, jaResolvido: true, arquivos: [], resumo: 'já resolvido' }
    }
    estado.sujo = true
    return { concluida: true, arquivos: o.semArquivos ? [] : arquivos, resumo: 'ok' }
  }
  const parallel = thunks => Promise.all(thunks.map(t => t().catch(() => null)))
  const resultado = await new FuncaoAssincrona('agent', 'parallel', 'log', 'phase', 'args', fonte)(
    agent, parallel, m => logs.push(m), () => {}, args)

  const labels = chamadas.map(c => c.label)
  return {
    resultado,
    estado,
    logs,
    chamadas,
    agentes: chamadas.length,
    commits: estado.git.length - 1,
    contar: prefixo => labels.filter(x => x.startsWith(prefixo)).length,
    prompt: label => chamadas.find(c => c.label === label)?.prompt ?? '',
    tipo: label => chamadas.find(c => c.label === label)?.agentType,
  }
}

export const plano = (extra = {}) => ({
  ...extra,
  milestones: [
    { titulo: 'M1', criterio: 'c', features: [{ titulo: 'F1', spec: 's' }, { titulo: 'F2', spec: 's' }] },
    { titulo: 'M2', criterio: 'c', features: [{ titulo: 'F3', spec: 's' }] },
  ],
})
