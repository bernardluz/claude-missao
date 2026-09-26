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
//   quedas             { [label]: vezes que o agente devolve null }
//   efeitoDaQueda      { [label]: 'commita' | 'suja' | 'commitaOrfao' | 'commitaFora' }
//   arquivosDaFeature  { [feature]: [caminhos] } o que essa feature declara e muda (padrão: arquivos/arquivosGit)
//   naoSao, mensagem   { [label]: valor } o que esse worker devolve nesses campos
//   semArquivos        worker não declara arquivos
//   jaResolvidoCorrecao correções voltam jaResolvido
//   jaResolvidoFeature { [feature]: true } essa feature original volta jaResolvido, sem arquivos
//   branchNaConferencia branch devolvida pela conferência (simula troca de branch)
//   commitDeFora       { [label]: sha } outra sessão commita os próprios arquivos logo depois desse agente
//   commitDeForaTudo   { [label]: sha } outra sessão faz `git commit -a` logo depois desse agente e leva o diff
//   suja               { [label]: caminho } outra sessão deixa mudança não commitada nesse caminho depois desse agente
//   workerCommita      { [label]: true } esse worker commita o próprio diff (proibido, mas acontece)
//   recusa             { [feature]: { motivo, commita?, ...campos } } o harness recusa um comando do agente de
//                      commit; com commita, a recusa vem depois do commit
//   shaErrado          { [feature]: sha } o agente de commit commita, mas declara outro SHA
//   falhaCommit        { [feature]: motivo } o commit falha uma vez por causa que não é gate nem lista
//   arquivosDeFora     arquivos dos commits que não são da missão (padrão ['z/fora.js'])
//   areas              áreas que o agente do contexto do plano devolve
//   aprendizados       { [label]: [textos] } aprendizados que esse agente devolve
//   simplicidade       [itens { tipo, texto, sugestao, classe }] que a verificação de simplicidade devolve
//   planoGerado        milestones que o agente de planejamento devolve (padrão: os de plano())
//   preVooFalta        [itens] o pré-voo acusa o que falta no ambiente
//   contratoFalso      { [milestone]: [premissas] } premissas que a prova de contrato devolve (use confere: false)
//   areasCaca          áreas que o agente barato deriva quando o milestone não traz caca (padrão ['geral'])
//   caca               { [milestone]: [n achados por rodada, por caçador] }
//   cacaRepete         { [milestone]: rodada } nessa rodada o caçador marca os achados como repetidos
//   cacaRepeteItem     número do item da lista de corrigidos que o caçador aponta (padrão 1; null para não apontar)
//   refuta             o segundo verificador refuta todos os achados
//   userTesting        { [milestone]: [n falhas por rodada] } resultado do user testing
//   semMedicao         o pré-voo não devolve a medição mesmo quando o prompt a pede
//   ui                 { [milestone]: texto } telas que o agente barato detecta (padrão: nenhuma)
//   utUx               [[bool por problema] por rodada] quais falhas do user testing são de UX
//   designLinks        links que o agente de UI/UX devolve
//   conferenciaErro    texto de erro que o agente de conferência sempre devolve (ex.: erro do git)
//   conferenciaResumida vezes que a conferência devolve só o último commit, com a contagem real
//   conferenciaSemPorCommit vezes que a conferência omite arquivosPorCommit
//   conferenciaComCerca o agente de conferência devolve o JSON dentro de cerca de código
//   conferenciaInvalida vezes que o agente de conferência devolve texto em vez da saída do git-estado.mjs
export const MEDICAO_ANTES = { linhas: 23000, tabelas: 34, filas: 6, arquivos: 410, testes: 120, comandos: 'git ls-files | wc -l' }
export const MEDICAO_DEPOIS = { linhas: 3800, tabelas: 6, filas: 0, arquivos: 60, testes: 40, comandos: 'git ls-files | wc -l' }
// estado.git: commits; estado.sujo: diff do worker (nos arquivos que o git lista); estado.alheios: linhas do
// `git status --porcelain` que não são da missão (de antes dela ou de outras sessões).
export async function executar(fonte, args, opcoes = {}, estado = { git: ['base0000'], sujo: false }) {
  const o = opcoes
  estado.alheios ??= []
  const quedas = { ...(o.quedas ?? {}) }
  const revisaoFeature = Object.fromEntries(Object.entries(o.revisaoFeature ?? {}).map(([k, v]) => [k, [...v]]))
  const gate = { ...(o.gate ?? {}) }
  const deFora = { ...(o.commitDeFora ?? {}) }
  const deForaTudo = { ...(o.commitDeForaTudo ?? {}) }
  const suja = { ...(o.suja ?? {}) }
  const falhaCommit = { ...(o.falhaCommit ?? {}) }
  const raiz = o.raiz ?? 'C:/repo'
  const arquivos = o.arquivos ?? ['x/a.js']
  const arquivosGit = o.arquivosGit ?? arquivos
  const arquivosDeFora = o.arquivosDeFora ?? ['z/fora.js']
  let invalida = o.conferenciaInvalida ?? 0
  let resumida = o.conferenciaResumida ?? 0
  let semPorCommit = o.conferenciaSemPorCommit ?? 0
  let rodadaValidacao = 0
  let rodadaSuite = 0
  const rodadaUT = {}
  let rodadaAceite = 0
  const chamadas = []
  const logs = []
  const novoSha = () => `sha${String(estado.git.length).padStart(5, '0')}`
  const caminhoDe = linha => linha.slice(3)
  // estado.sujo: true (todos os arquivos que o git lista), lista dos que sobraram depois de um commit, ou false.
  const pendentesDoWorker = () => (estado.sujo === true ? arquivosGit : Array.isArray(estado.sujo) ? estado.sujo : [])
  const pendencias = () => {
    const doWorker = pendentesDoWorker().map(a => (a.includes(' -> ') ? `R  ${a}` : ` M ${a}`))
    return [...doWorker, ...estado.alheios.filter(l => !doWorker.some(d => caminhoDe(d) === caminhoDe(l)))]
  }
  const limpo = () => pendencias().length === 0

  const responder = async (prompt, opt) => {
    chamadas.push({ label: opt.label, phase: opt.phase, agentType: opt.agentType, model: opt.model, effort: opt.effort, schema: opt.schema, prompt })
    const l = opt.label
    if (quedas[l] > 0) {
      quedas[l]--
      const efeito = o.efeitoDaQueda?.[l]
      if (efeito === 'commita') { estado.git.push(novoSha()); estado.sujo = false }
      if (efeito === 'suja') estado.sujo = true
      if (efeito === 'commitaOrfao') estado.git.push('orfao000')
      if (efeito === 'commitaFora') { estado.git.push('fora0009'); estado.porSha ??= {}; estado.porSha.fora0009 = arquivosDeFora }
      return null
    }
    if (l === 'contexto do plano') return { areas: o.areas ?? [] }
    if (l === 'simplicidade') return { itens: o.simplicidade ?? [] }
    if (l === 'planejar') return { milestones: o.planoGerado ?? plano().milestones }
    // Quando o prompt pede a medição (modo enxugar), o pré-voo mede o antes e o aceite, o depois.
    const pedeMedicao = /devolva em medicao/.test(prompt)
    if (l === 'pré-voo') return { ok: !o.preVooFalta, faltando: o.preVooFalta ?? [], ...(pedeMedicao && !o.semMedicao ? { medicao: MEDICAO_ANTES } : {}) }
    if (l === 'preparo' || l === 'conferência') {
      if (o.conferenciaErro) return { saida: o.conferenciaErro }
      if (invalida > 0) { invalida--; return { saida: 'o repositório tem 3 commits novos e está limpo' } }
      const cerca = o.conferenciaComCerca ? s => `Saída:\n\`\`\`json\n${s}\n\`\`\`` : s => s
      // Como o git-estado.mjs: `HEAD` como base dá intervalo vazio.
      const [, base, baseMilestone, foraTexto] = prompt.match(/git-estado\.mjs (\S+)(?: --resumo (\S+)((?: \S+)*))?`/)
      const commits = base === 'HEAD' ? [] : estado.git.slice(estado.git.indexOf(base) + 1)
      const deFora = s => !/^sha\d+$/.test(s)
      // Os arquivos de cada commit ficam gravados no estado na primeira leitura, como no git real entre execuções.
      estado.porSha ??= {}
      for (const s of commits) estado.porSha[s] ??= deFora(s) ? arquivosDeFora : arquivosGit
      const arquivosPorCommit = Object.fromEntries(commits.map(s => [s, estado.porSha[s]]))
      const arquivosDoIntervalo = [...new Set(commits.flatMap(s => arquivosPorCommit[s]))]
      const contagem = { commits: commits.length, arquivos: arquivosDoIntervalo.length, pendencias: pendencias().length }
      const saida = {
        branch: l === 'preparo' ? 'develop' : o.branchNaConferencia ?? 'develop', head: estado.git.at(-1), raiz,
        limpo: limpo(), pendencias: pendencias(), commits, arquivos: arquivosDoIntervalo, arquivosPorCommit, contagem,
      }
      if (baseMilestone) {
        // Modo compacto: uniões já feitas, sem os commits de fora passados e sem arquivosPorCommit.
        const foraPassados = (foraTexto ?? '').trim().split(/\s+/).filter(Boolean)
        const daMissao = commits.filter(s => !foraPassados.includes(s))
        const desde = baseMilestone === base ? 0 : commits.indexOf(baseMilestone) + 1
        const uniao = lista => [...new Set(lista.flatMap(s => arquivosPorCommit[s]))]
        delete saida.arquivosPorCommit
        saida.resumo = true
        saida.arquivos = uniao(daMissao)
        saida.arquivosDoMilestone = uniao(daMissao.filter(s => commits.indexOf(s) >= desde))
        saida.contagem = { ...contagem, arquivos: saida.arquivos.length, arquivosDoMilestone: saida.arquivosDoMilestone.length }
        return { saida: cerca(JSON.stringify(saida)) }
      }
      if (resumida > 0 && commits.length > 1) { resumida--; saida.commits = [commits.at(-1)] }
      if (semPorCommit > 0) { semPorCommit--; delete saida.arquivosPorCommit }
      return { saida: cerca(JSON.stringify(saida)) }
    }
    if (l === 'suíte completa') {
      if (o.suiteAmbiente) return { aprovado: false, problemas: [{ problema: 'Docker fora do ar', ambiente: true }] }
      const n = (o.suite ?? [])[rodadaSuite++] ?? 0
      return { aprovado: n === 0, problemas: problemas(n, 's') }
    }
    if (l.startsWith('telas: ')) return { ui: o.ui?.[l.slice(7)] ?? '' }
    if (l.startsWith('design: ')) return { texto: `desenho de ${l.slice(8)}: seletor pesquisável de conta`, links: o.designLinks ?? [] }
    if (l.startsWith('contrato: ')) return { premissas: o.contratoFalso?.[l.slice(10)] ?? [] }
    if (l.startsWith('áreas de caça: ')) return { areas: o.areasCaca ?? ['geral'] }
    const caca = l.match(/^caça: .* \((.+), rodada (\d+)\)$/)
    if (caca) {
      const [, m, r] = caca
      const n = (o.caca?.[m] ?? [])[Number(r) - 1] ?? 0
      return { achados: Array.from({ length: n }, (_, i) => ({ arquivo: 'x/a.js', problema: `bug ${r}.${i + 1}`, ...(o.cacaRepete?.[m] === Number(r) ? { repete: true, repeteItem: 'cacaRepeteItem' in o ? o.cacaRepeteItem : 1 } : {}) })) }
    }
    if (l.startsWith('verificação ')) return { confirmado: !(o.refuta && l.startsWith('verificação 2')), motivo: 'reproduzido' }
    if (l === 'aceite') {
      const n = (o.aceiteFalta ?? [])[rodadaAceite++] ?? 0
      return { criterios: [{ criterio: 'c ok', evidencia: 'teste T passou', atendido: true },
        ...Array.from({ length: n }, (_, i) => ({ criterio: `c${i + 1}`, evidencia: 'sem teste', atendido: false }))],
        ...(pedeMedicao ? { medicao: MEDICAO_DEPOIS } : {}) }
    }
    if (l.startsWith('user testing: ')) {
      const m = l.slice(14)
      const i = rodadaUT[m] ?? 0
      rodadaUT[m] = i + 1
      const n = (o.userTesting?.[m] ?? [])[i] ?? 0
      return { aprovado: n === 0, problemas: problemas(n, 'u').map((p, j) => (o.utUx?.[i]?.[j] ? { ...p, ux: true } : p)) }
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
      // O agente só roda o comando pronto: o simulador commita exatamente os caminhos do `git add -- ...`.
      const f = l.slice(8)
      const { commita: recusaDepois, ...recusa } = o.recusa?.[f] ?? {}
      if (o.recusa?.[f] && !recusaDepois) return { recusado: true, ...recusa }
      const headAtual = () => `head=${estado.git.at(-1)}`
      if (gate[f] > 0) { gate[f]--; return { saida: `saida=1\nlint falhou\n${headAtual()}` } }
      if (falhaCommit[f]) { const motivo = falhaCommit[f]; delete falhaCommit[f]; return { saida: motivo } }
      const lista = [...(/git add -- (.+?) > "\$log"/.exec(prompt)?.[1] ?? '').matchAll(/'([^']*)'/g)].map(x => x[1])
      const doWorker = pendentesDoWorker()
      const levados = doWorker.filter(p => p.split(' -> ').every(x => lista.includes(x)))
      const alheiosLevados = estado.alheios.map(caminhoDe).filter(p => lista.includes(p))
      if (!levados.length && !alheiosLevados.length) return { saida: `saida=1\nnothing to commit\n${headAtual()}` }
      const sha = novoSha()
      estado.git.push(sha)
      estado.porSha ??= {}
      estado.porSha[sha] = [...new Set([...levados.flatMap(p => p.split(' -> ')), ...alheiosLevados])]
      const resto = doWorker.filter(p => !levados.includes(p))
      estado.sujo = resto.length ? resto : false
      estado.alheios = estado.alheios.filter(x => !alheiosLevados.includes(caminhoDe(x)))
      if (recusaDepois) return { recusado: true, ...recusa, saida: `saida=0\n${headAtual()}` }
      return { saida: `saida=0\n[develop ${sha}]\nhead=${o.shaErrado?.[f] ?? sha}` }
    }
    // worker, ajuste ou correção
    if (o.jaResolvidoCorrecao && opt.phase === 'Corrigir' && !l.includes('ajuste')) {
      return { concluida: true, jaResolvido: true, arquivos: [], resumo: 'já resolvido' }
    }
    if (o.jaResolvidoFeature?.[l]) return { concluida: true, jaResolvido: true, arquivos: [], resumo: 'o teste já existe' }
    const daFeature = o.arquivosDaFeature?.[l.split(' · ')[0]]
    estado.sujo = daFeature ?? true
    const declarados = l.includes(' · ajuste ') ? o.arquivosAjuste ?? daFeature ?? arquivos : daFeature ?? arquivos
    return { concluida: true, arquivos: o.semArquivos ? [] : declarados, resumo: 'ok' }
  }
  // Efeitos de fora do agente (outra sessão, crash do bash) acontecem depois que ele responde ou cai.
  const agent = async (prompt, opt) => {
    const r = await responder(prompt, opt)
    const l = opt.label
    if (r && o.aprendizados?.[l]) r.aprendizados = o.aprendizados[l]
    if (r && o.naoSao?.[l]) r.naoSao = o.naoSao[l]
    if (r && o.mensagem?.[l]) r.mensagem = o.mensagem[l]
    if (r && deFora[l]) { estado.git.push(deFora[l]); delete deFora[l] }
    if (r && deForaTudo[l]) { estado.git.push(deForaTudo[l]); estado.sujo = false; delete deForaTudo[l] }
    if (r && o.workerCommita?.[l] && estado.sujo) {
      const sha = novoSha()
      estado.git.push(sha)
      estado.porSha ??= {}
      estado.porSha[sha] = pendentesDoWorker()
      estado.sujo = false
    }
    if (r && suja[l]) { estado.alheios.push(` M ${suja[l]}`); delete suja[l] }
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
