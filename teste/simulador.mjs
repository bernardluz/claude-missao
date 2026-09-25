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
//   arquivosAjuste     caminhos que o ajuste declara (padrão = arquivos)
//   revisaoFeature     { [feature]: [n problemas por rodada] }
//   validacao          [n problemas por rodada de validação do milestone] (lidos pelo revisor do milestone)
//   suite              [n falhas por rodada da suíte completa final]
//   suiteAmbiente      a suíte falha por ambiente
//   gate               { [feature]: vezes que o gate falha }
//   foraDaLista        { [feature]: vezes que o commit acusa mudança fora da lista }
//   quedas             { [label]: vezes que o agente devolve null }
//   efeitoDaQueda      { [label]: 'commita' | 'suja' | 'commitaOrfao' }
//   semArquivos        worker não declara arquivos
//   jaResolvidoCorrecao correções voltam jaResolvido
//   branchNaConferencia branch devolvida pela conferência (simula troca de branch)
//   commitDeFora       { [label]: sha } outra sessão commita os próprios arquivos logo depois desse agente
//   commitDeForaTudo   { [label]: sha } outra sessão faz `git commit -a` logo depois desse agente e leva o diff
//   suja               { [label]: vezes } outra sessão deixa mudança não commitada depois desse agente
//   recusa             { [feature]: { motivo, commita?, ...campos } } o harness recusa um comando do agente de
//                      commit; com commita, a recusa vem depois do commit
//   shaErrado          { [feature]: sha } o agente de commit commita, mas declara outro SHA
//   falhaCommit        { [feature]: motivo } o commit falha uma vez por causa que não é gate nem lista
//   dump               { [label]: vezes } o bash desse agente cai, mesmo que ele caia junto, e deixa um dump
//   caminhoDump        onde o dump aparece (padrão bash.exe.stackdump, na raiz)
//   ignoraDump         { [feature]: vezes } o agente de commit lista o dump como fora da lista em vez de apagá-lo
//   apagaAlem          { [feature]: [caminhos] } o agente de commit apaga e informa também o que não é dump
//   arquivosDeFora     arquivos dos commits que não são da missão (padrão ['z/fora.js'])
//   areas              áreas que o agente do contexto do plano devolve
//   aprendizados       { [label]: [textos] } aprendizados que esse agente devolve
//   perguntas, cortes  o que a verificação de simplicidade devolve (qualquer um deles faz a missão parar)
//   planoGerado        milestones que o agente de planejamento devolve (padrão: os de plano())
//   preVooFalta        [itens] o pré-voo acusa o que falta no ambiente
//   contratoFalso      { [milestone]: [premissas] } premissas que a prova de contrato devolve (use confere: false)
//   areasCaca          áreas que o agente barato deriva quando o milestone não traz caca (padrão ['geral'])
//   caca               { [milestone]: [n achados por rodada, por caçador] }
//   cacaRepete         { [milestone]: rodada } nessa rodada os achados repetem bug já corrigido
//   refuta             o segundo verificador refuta todos os achados
//   userTesting        { [milestone]: [n falhas por rodada] } resultado do user testing
//   foraImpacta     resposta do agente que julga commit de fora (padrão true: para como antes)
//   conferenciaComCerca o agente de conferência devolve o JSON dentro de cerca de código
//   conferenciaInvalida vezes que o agente de conferência devolve texto em vez da saída do git-estado.mjs
export const DUMP = 'bash.exe.stackdump'
export async function executar(fonte, args, opcoes = {}, estado = { git: ['base0000'], sujo: false }) {
  const o = opcoes
  estado.dumps ??= []
  const quedas = { ...(o.quedas ?? {}) }
  const revisaoFeature = Object.fromEntries(Object.entries(o.revisaoFeature ?? {}).map(([k, v]) => [k, [...v]]))
  const gate = { ...(o.gate ?? {}) }
  const fora = { ...(o.foraDaLista ?? {}) }
  const deFora = { ...(o.commitDeFora ?? {}) }
  const deForaTudo = { ...(o.commitDeForaTudo ?? {}) }
  const suja = { ...(o.suja ?? {}) }
  const dump = { ...(o.dump ?? {}) }
  const caminhoDump = o.caminhoDump ?? DUMP
  const ignoraDump = { ...(o.ignoraDump ?? {}) }
  const falhaCommit = { ...(o.falhaCommit ?? {}) }
  const raiz = o.raiz ?? 'C:/repo'
  const arquivos = o.arquivos ?? ['x/a.js']
  const arquivosGit = o.arquivosGit ?? arquivos
  const arquivosDeFora = o.arquivosDeFora ?? ['z/fora.js']
  let invalida = o.conferenciaInvalida ?? 0
  let rodadaValidacao = 0
  let rodadaSuite = 0
  const rodadaUT = {}
  let rodadaAceite = 0
  const chamadas = []
  const logs = []
  const novoSha = () => `sha${String(estado.git.length).padStart(5, '0')}`
  const limpo = () => !estado.sujo && estado.dumps.length === 0
  const pendencias = () => [...(estado.sujo ? [' M x/a.js'] : []), ...estado.dumps.map(d => `?? ${d}`)]

  const responder = async (prompt, opt) => {
    chamadas.push({ label: opt.label, phase: opt.phase, agentType: opt.agentType, model: opt.model, effort: opt.effort, prompt })
    const l = opt.label
    if (quedas[l] > 0) {
      quedas[l]--
      const efeito = o.efeitoDaQueda?.[l]
      if (efeito === 'commita') { estado.git.push(novoSha()); estado.sujo = false }
      if (efeito === 'suja') estado.sujo = true
      if (efeito === 'commitaOrfao') estado.git.push('orfao000')
      return null
    }
    if (l === 'commit de fora') return { impacta: o.foraImpacta ?? true, motivo: 'julgado pelo agente' }
    if (l === 'contexto do plano') return { areas: o.areas ?? [] }
    if (l === 'simplicidade') return { ok: !o.perguntas && !o.cortes, perguntas: o.perguntas ?? [], cortes: o.cortes ?? [] }
    if (l === 'planejar') return { milestones: o.planoGerado ?? plano().milestones }
    if (l === 'pré-voo') return { ok: !o.preVooFalta, faltando: o.preVooFalta ?? [] }
    if (l === 'preparo' || l === 'conferência') {
      if (invalida > 0) { invalida--; return { saida: 'o repositório tem 3 commits novos e está limpo' } }
      const cerca = o.conferenciaComCerca ? s => `Saída:\n\`\`\`json\n${s}\n\`\`\`` : s => s
      // Como o git-estado.mjs: `HEAD` como base dá intervalo vazio.
      const base = prompt.match(/git-estado\.mjs (\S+)`/)[1]
      const commits = base === 'HEAD' ? [] : estado.git.slice(estado.git.indexOf(base) + 1)
      const deFora = s => !/^sha\d+$/.test(s)
      // Os arquivos de cada commit ficam gravados no estado na primeira leitura, como no git real entre execuções.
      estado.porSha ??= {}
      for (const s of commits) estado.porSha[s] ??= deFora(s) ? arquivosDeFora : arquivosGit
      const arquivosPorCommit = Object.fromEntries(commits.map(s => [s, estado.porSha[s]]))
      return {
        saida: cerca(JSON.stringify({
          branch: l === 'preparo' ? 'develop' : o.branchNaConferencia ?? 'develop', head: estado.git.at(-1), raiz,
          limpo: limpo(), pendencias: pendencias(), commits,
          arquivos: [...new Set(commits.flatMap(s => arquivosPorCommit[s]))], arquivosPorCommit,
        })),
      }
    }
    if (l === 'suíte completa') {
      if (o.suiteAmbiente) return { aprovado: false, problemas: [{ problema: 'Docker fora do ar', ambiente: true }] }
      const n = (o.suite ?? [])[rodadaSuite++] ?? 0
      return { aprovado: n === 0, problemas: problemas(n, 's') }
    }
    if (l.startsWith('contrato: ')) return { premissas: o.contratoFalso?.[l.slice(10)] ?? [] }
    if (l.startsWith('áreas de caça: ')) return { areas: o.areasCaca ?? ['geral'] }
    const caca = l.match(/^caça: .* \((.+), rodada (\d+)\)$/)
    if (caca) {
      const [, m, r] = caca
      const n = (o.caca?.[m] ?? [])[Number(r) - 1] ?? 0
      return { achados: Array.from({ length: n }, (_, i) => ({ arquivo: 'x/a.js', problema: `bug ${r}.${i + 1}`, repete: o.cacaRepete?.[m] === Number(r) })) }
    }
    if (l.startsWith('verificação ')) return { confirmado: !(o.refuta && l.startsWith('verificação 2')), motivo: 'reproduzido' }
    if (l === 'aceite') {
      const n = (o.aceiteFalta ?? [])[rodadaAceite++] ?? 0
      return { criterios: [{ criterio: 'c ok', evidencia: 'teste T passou', atendido: true },
        ...Array.from({ length: n }, (_, i) => ({ criterio: `c${i + 1}`, evidencia: 'sem teste', atendido: false }))] }
    }
    if (l.startsWith('user testing: ')) {
      const m = l.slice(14)
      const i = rodadaUT[m] ?? 0
      rodadaUT[m] = i + 1
      const n = (o.userTesting?.[m] ?? [])[i] ?? 0
      return { aprovado: n === 0, problemas: problemas(n, 'u') }
    }
    if (opt.phase === 'Scrutiny') {
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
      const { commita: recusaDepois, ...recusa } = o.recusa?.[f] ?? {}
      if (o.recusa?.[f] && !recusaDepois) return { commitado: false, recusado: true, ...recusa }
      // Segue o prompt, salvo ignoraDump: o dump do bash na raiz é apagado e informado, nunca listado como fora da lista.
      const naRaiz = estado.dumps.filter(d => !d.includes('/'))
      const listaDump = naRaiz.length > 0 && ignoraDump[f] > 0
      if (listaDump) ignoraDump[f]--
      const listados = listaDump ? naRaiz : []
      if (!listaDump) estado.dumps = estado.dumps.filter(d => d.includes('/'))
      const descartados = [...(listaDump ? [] : naRaiz), ...(o.apagaAlem?.[f] ?? [])]
      const com = r => (descartados.length ? { ...r, descartados } : r)
      if (fora[f] > 0) { fora[f]--; return com({ commitado: false, foraDaLista: [...listados, 'y/b.js'] }) }
      if (listados.length) return com({ commitado: false, foraDaLista: listados })
      if (gate[f] > 0) { gate[f]--; return com({ commitado: false, gateFalhou: true, motivo: 'lint' }) }
      if (falhaCommit[f]) { const motivo = falhaCommit[f]; delete falhaCommit[f]; return com({ commitado: false, motivo }) }
      if (!estado.sujo) return com({ commitado: false, motivo: 'nada a commitar' })
      const sha = novoSha()
      estado.git.push(sha)
      estado.sujo = false
      if (recusaDepois) return com({ commitado: true, commit: sha, recusado: true, ...recusa })
      return com({ commitado: true, commit: o.shaErrado?.[f] ?? sha })
    }
    // worker, ajuste ou correção
    if (o.jaResolvidoCorrecao && opt.phase === 'Corrigir' && !l.includes('ajuste')) {
      return { concluida: true, jaResolvido: true, arquivos: [], resumo: 'já resolvido' }
    }
    estado.sujo = true
    const declarados = l.includes(' · ajuste ') ? o.arquivosAjuste ?? arquivos : arquivos
    return { concluida: true, arquivos: o.semArquivos ? [] : declarados, resumo: 'ok' }
  }
  // Efeitos de fora do agente (outra sessão, crash do bash) acontecem depois que ele responde ou cai.
  const agent = async (prompt, opt) => {
    const r = await responder(prompt, opt)
    const l = opt.label
    if (r && o.aprendizados?.[l]) r.aprendizados = o.aprendizados[l]
    if (r && deFora[l]) { estado.git.push(deFora[l]); delete deFora[l] }
    if (r && deForaTudo[l]) { estado.git.push(deForaTudo[l]); estado.sujo = false; delete deForaTudo[l] }
    if (r && suja[l] > 0) { suja[l]--; estado.sujo = true }
    if (dump[l] > 0) { dump[l]--; if (!estado.dumps.includes(caminhoDump)) estado.dumps.push(caminhoDump) }
    return r
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
