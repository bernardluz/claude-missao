export const meta = {
  name: 'missao',
  description: 'Executa um plano em milestones: features em série com commit atômico, validação e correções, parando se não fechar',
  whenToUse: 'Trabalho grande já planejado em milestones e features (estilo Factory Missions). Passe o plano em args; para retomar, passe em args.retomar o objeto devolvido na parada. Agente pulado é retentado: use maxRetentativasInfra 0 para evitar.',
  phases: [
    { title: 'Preparar', detail: 'confere árvore limpa, branch e HEAD base' },
    { title: 'Skills', detail: 'guias da missão por tipo de feature, só nesta execução' },
    { title: 'Implementar', detail: 'por feature, em série: implementa, revisão independente, commit' },
    { title: 'Validar', detail: 'confere commits, revisão + testes sobre o milestone' },
    { title: 'Corrigir', detail: 'um item por problema apontado, com revisão e commit próprios' },
    { title: 'Suíte final', detail: 'suíte completa do projeto ao fim; falhas viram correções' },
  ],
}

// claude-missao: núcleo genérico. Num projeto, este arquivo é gerado por `instalar.mjs` com a configuração do
// projeto embutida em CONFIG_PROJETO; edite no repositório claude-missao, não na cópia instalada.
//
// args: { milestones: [{ titulo, criterio, features: [{ titulo, spec }] }], maxRodadasCorrecao?, maxProblemasPorRodada?,
//         maxRodadasRevisao?, maxFeaturesPorMilestone?, maxRetentativasInfra?, retomar?, config? }
// Um commit atômico por feature, só depois de revisão independente aprovada; a validação do milestone revisa e
// testa o conjunto e cria etapas de correção, em loop até aprovar ou parar de progredir. Depois do último milestone,
// a suíte completa do que a missão tocou, e de quem depende disso, roda uma vez e entra no mesmo loop de correção.
// Correções seguem enquanto a validação aponta menos problemas que na rodada anterior; o teto só evita loop infinito.
// Skills da missão vivem só nesta execução: vão no prompt dos workers e no retorno, nunca em .claude/skills/.
// Milestones pequenos: validar cedo evita o acúmulo de erros de um milestone gigante validado só no fim.
// Agente que não retorna (modelo/API caiu) é retentado; worker só é retentado se não deixou rastro no repositório.
// Retomada em outra sessão: passe em args.retomar o objeto `retomar` devolvido quando a execução parou.
// Não renomeie features entre execuções: concluidas casa pelo título exato.

// Configuração do projeto. Cada chave é opcional. Numa execução, args.config só ajusta chaves de texto: quem monta
// os args é o agente que lança o workflow, e ele não pode desligar revisor nem proibições do projeto.
const PADRAO = {
  // Arquivo com a política de testes do projeto, citado aos workers. null: "testes focados com o runner do projeto".
  regrasTestes: null,
  // Arquivo que exige a revisão independente, citado aos workers. null: não cita arquivo.
  regrasProjeto: null,
  // agentType do revisor padrão (read-only). null: agente padrão do Workflow, instruído a só ler.
  revisor: null,
  // Revisor específico quando TODOS os arquivos estão sob o prefixo. Ex.: [{ prefixo: 'services/', agentType: 'kotlin-reviewer' }]
  revisoresPorPasta: [],
  // agentType read-only para skills e conferência do git (ex.: 'explorer'). null: agente padrão.
  leitor: null,
  // Proibições extras além das de git. Ex.: ['variáveis MEUPROJETO_SKIP_*']
  proibicoesExtras: [],
  // Formato e idioma da mensagem de commit.
  formatoCommit: '`<tipo>: <descrição>`',
  idioma: 'pt-BR',
  // Exemplos de tipos de trabalho para o agente que monta as skills da missão.
  exemplosSkills: 'migration + entidade, endpoint com teste de integração, tela',
  // Como rodar, ao fim da missão, a suíte completa do que a missão tocou e de quem depende disso (comando ou
  // instrução; {inicio} vira o commit onde a missão começou). null: o agente descobre módulos tocados e dependentes.
  suiteCompleta: null,
}
// @config-inicio (substituído por instalar.mjs)
const CONFIG_PROJETO = {}
// @config-fim
const AJUSTAVEIS_POR_EXECUCAO = ['formatoCommit', 'idioma', 'exemplosSkills']
{
  const negadas = Object.keys(args?.config ?? {}).filter(k => !AJUSTAVEIS_POR_EXECUCAO.includes(k))
  if (negadas.length) {
    throw new Error(`args.config só ajusta ${AJUSTAVEIS_POR_EXECUCAO.join(', ')}; ${negadas.join(', ')} vem da configuração ` +
      `instalada no projeto (.claude/missao.config.json)`)
  }
}
const CONFIG = { ...PADRAO, ...CONFIG_PROJETO, ...(args?.config ?? {}) }
{
  const texto = v => v === null || typeof v === 'string'
  const erros = Object.keys(CONFIG).filter(k => !(k in PADRAO)).map(k => `chave desconhecida: ${k}`)
  for (const k of ['regrasTestes', 'regrasProjeto', 'revisor', 'leitor', 'suiteCompleta']) if (!texto(CONFIG[k])) erros.push(`${k} deve ser texto ou null`)
  for (const k of ['formatoCommit', 'idioma', 'exemplosSkills']) if (typeof CONFIG[k] !== 'string') erros.push(`${k} deve ser texto`)
  if (!Array.isArray(CONFIG.revisoresPorPasta) || !CONFIG.revisoresPorPasta.every(r => r && typeof r.prefixo === 'string' && typeof r.agentType === 'string')) {
    erros.push('revisoresPorPasta deve ser lista de { prefixo, agentType }')
  }
  if (!Array.isArray(CONFIG.proibicoesExtras) || !CONFIG.proibicoesExtras.every(x => typeof x === 'string')) erros.push('proibicoesExtras deve ser lista de textos')
  if (erros.length) throw new Error(`configuração inválida: ${erros.join('; ')}`)
}
const comoAgente = tipo => tipo ?? undefined
function revisorPara(arquivos) {
  const r = CONFIG.revisoresPorPasta.find(x => arquivos.length > 0 && arquivos.every(a => a.startsWith(x.prefixo)))
  return comoAgente(r ? r.agentType : CONFIG.revisor)
}

const MAX_RODADAS_CORRECAO = args?.maxRodadasCorrecao ?? 5
const MAX_PROBLEMAS_POR_RODADA = args?.maxProblemasPorRodada ?? 10
const MAX_RODADAS_REVISAO = args?.maxRodadasRevisao ?? 3
const MAX_FEATURES_POR_MILESTONE = args?.maxFeaturesPorMilestone ?? 8
const MAX_RETENTATIVAS_INFRA = args?.maxRetentativasInfra ?? 2

const GIT_PROIBIDO =
  'Trabalhe só no HEAD atual da branch. Proibido: ' +
  ['checkout', 'switch', 'stash', 'reset', 'restore de arquivos alheios', 'rebase', 'merge', 'cherry-pick',
    'criar branch', 'amend', 'push', '--no-verify', ...CONFIG.proibicoesExtras].join(', ') + '.'
const TESTES = CONFIG.regrasTestes
  ? `Siga ${CONFIG.regrasTestes} para escolher e rodar os testes focados`
  : 'Escolha e rode os testes focados que cobrem a mudança, com o runner já adotado no projeto'
const SAIDA_EM_ARQUIVO =
  'Ao rodar build, testes ou gates (Maven, Gradle, npm, hooks do git), mande a saída para um arquivo temporário FORA ' +
  'do repositório e leia o arquivo depois: `log=$(mktemp); <comando> > "$log" 2>&1; echo "saida=$?"; tail -40 "$log"`. ' +
  'Nunca leia a saída por pipe (`| tail`, `| head`, `| tee`): um daemon que o comando deixa vivo, como o do compilador ' +
  'Kotlin, herda o pipe e o comando nunca termina.'

const PREPARO = {
  type: 'object',
  properties: {
    limpo: { type: 'boolean' },
    branch: { type: 'string' },
    head: { type: 'string' },
    raiz: { type: 'string' },
    pendencias: { type: 'array', items: { type: 'string' } },
  },
  required: ['limpo', 'branch', 'head', 'raiz'],
}

const RESULTADO_FEATURE = {
  type: 'object',
  properties: {
    concluida: { type: 'boolean' },
    jaResolvido: { type: 'boolean' },
    arquivos: { type: 'array', items: { type: 'string' } },
    resumo: { type: 'string' },
    testesRodados: { type: 'array', items: { type: 'string' } },
  },
  required: ['concluida', 'resumo'],
}

const RESULTADO_COMMIT = {
  type: 'object',
  properties: {
    commitado: { type: 'boolean' },
    commit: { type: 'string' },
    gateFalhou: { type: 'boolean' },
    foraDaLista: { type: 'array', items: { type: 'string' } },
    motivo: { type: 'string' },
  },
  required: ['commitado'],
}

const CONFERENCIA = {
  type: 'object',
  properties: {
    branch: { type: 'string' },
    head: { type: 'string' },
    limpo: { type: 'boolean' },
    commits: { type: 'array', items: { type: 'string' } },
    arquivos: { type: 'array', items: { type: 'string' } },
  },
  required: ['branch', 'head', 'limpo', 'commits', 'arquivos'],
}

const SKILLS = {
  type: 'object',
  properties: {
    skills: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          nome: { type: 'string' },
          guia: { type: 'string' },
          features: { type: 'array', items: { type: 'string' } },
        },
        required: ['nome', 'guia', 'features'],
      },
    },
  },
  required: ['skills'],
}

const VALIDACAO = {
  type: 'object',
  properties: {
    aprovado: { type: 'boolean' },
    problemas: {
      type: 'array',
      items: {
        type: 'object',
        properties: { arquivo: { type: 'string' }, problema: { type: 'string' }, ambiente: { type: 'boolean' } },
        required: ['problema'],
      },
    },
  },
  required: ['aprovado', 'problemas'],
}

const planoValido = args && Array.isArray(args.milestones) && args.milestones.length > 0 &&
  args.milestones.every(m => m && m.titulo && m.criterio && Array.isArray(m.features) && m.features.length > 0 &&
    m.features.every(f => f && f.titulo && f.spec)) &&
  [MAX_RODADAS_CORRECAO, MAX_PROBLEMAS_POR_RODADA, MAX_RODADAS_REVISAO, MAX_FEATURES_POR_MILESTONE].every(n => Number.isInteger(n) && n >= 1) &&
  Number.isInteger(MAX_RETENTATIVAS_INFRA) && MAX_RETENTATIVAS_INFRA >= 0
if (!planoValido) {
  throw new Error('args inválido: { milestones: [{ titulo, criterio, features: [{ titulo, spec }] }], ' +
    'maxRodadasCorrecao?, maxProblemasPorRodada?, maxRodadasRevisao?, maxFeaturesPorMilestone?, maxRetentativasInfra?, retomar? }, ' +
    'sem listas vazias, limites inteiros ≥ 1 e retentativas ≥ 0')
}
const repetidosEm = lista => [...new Set(lista.filter((t, i) => lista.indexOf(t) !== i))]
const featuresRepetidas = repetidosEm(args.milestones.flatMap(m => m.features.map(f => f.titulo)))
if (featuresRepetidas.length) throw new Error(`títulos de feature repetidos: ${featuresRepetidas.join(', ')}`)
const milestonesRepetidos = repetidosEm(args.milestones.map(m => m.titulo))
if (milestonesRepetidos.length) throw new Error(`títulos de milestone repetidos: ${milestonesRepetidos.join(', ')}`)
const grandes = args.milestones.filter(m => m.features.length > MAX_FEATURES_POR_MILESTONE)
if (grandes.length) {
  throw new Error(`milestones acima de ${MAX_FEATURES_POR_MILESTONE} features (divida em milestones menores ou ` +
    `ajuste maxFeaturesPorMilestone): ${grandes.map(m => `${m.titulo} (${m.features.length})`).join(', ')}`)
}

// A suíte completa roda uma vez ao fim, como uma etapa sem features: falha vira correção no mesmo loop.
const SUITE = { titulo: 'Suíte final', criterio: 'a suíte completa do projeto passa', features: [], suite: true }
if (args.milestones.some(m => m.titulo === SUITE.titulo)) throw new Error(`"${SUITE.titulo}" é reservado; renomeie o milestone`)
const etapas = [...args.milestones, SUITE]

const retomar = args.retomar ?? null
const inicio = retomar ? etapas.findIndex(m => m.titulo === retomar.aPartirDe) : 0
if (retomar && (inicio < 0 || typeof retomar.base !== 'string' || retomar.base.length < 7 ||
  typeof retomar.head !== 'string' || retomar.head.length < 7 || !Array.isArray(retomar.commits) ||
  (retomar.concluidas !== undefined && !Array.isArray(retomar.concluidas)) ||
  (retomar.inicioMissao !== undefined && (typeof retomar.inicioMissao !== 'string' || retomar.inicioMissao.length < 7)))) {
  throw new Error('args.retomar inválido: use o objeto `retomar` devolvido pela execução que parou ({ aPartirDe, inicioMissao, base, head, commits, concluidas })')
}
const pendentes = etapas.slice(inicio)
if (inicio > 0) log(`Retomando em "${retomar.aPartirDe}": ${inicio} etapas anteriores já entregues`)

const totalFeatures = pendentes.reduce((n, m) => n + m.features.length, 0)
const milestonesPendentes = pendentes.filter(m => !m.suite).length
// por milestone: 2 conferências + 2 validadores; suíte final: 2 conferências + 1 validador
const estimativa = 2 + 3 * totalFeatures + 4 * milestonesPendentes + 3
log(`Estimativa mínima: ${estimativa} agentes (sem contar correções e retentativas)`)

// agent() devolve null quando o modelo/API cai; nas Missions da Factory quase toda falha de worker foi assim.
// antesDeRetentar confirma que repetir é seguro; se não for, devolve { semRetentativa: estado }.
// Pular um agente manualmente também produz null: para interromper de fato, rode com maxRetentativasInfra 0.
async function comRetentativa(rotulo, chamar, antesDeRetentar) {
  let r = await chamar()
  for (let t = 1; !r && t <= MAX_RETENTATIVAS_INFRA; t++) {
    if (antesDeRetentar) {
      const estado = await antesDeRetentar()
      if (!estado.ok) return { semRetentativa: estado }
    }
    log(`${rotulo}: agente não retornou (queda ou pulo manual), tentativa ${t + 1} de ${MAX_RETENTATIVAS_INFRA + 1}`)
    r = await chamar()
  }
  return r
}

phase('Preparar')
const preparo = await comRetentativa('preparo', () => agent(
  'Rode `git status --porcelain`, `git branch --show-current`, `git rev-parse HEAD` (SHA completo) e ' +
  '`git rev-parse --show-toplevel` (raiz). ' +
  'Não altere nada. Informe se a árvore está limpa e liste as pendências, se houver.',
  { label: 'preparo', phase: 'Preparar', schema: PREPARO },
))
if (!preparo || !preparo.limpo || !preparo.branch) {
  return {
    parouEm: 'preparo',
    motivo: preparo
      ? 'árvore com mudanças pendentes ou HEAD destacado; commits atômicos exigem partir de branch limpa'
      : 'agente de preparo não retornou',
    pendencias: preparo?.pendencias ?? [],
  }
}
log(`Branch ${preparo.branch}, base ${preparo.head}`)

let head = preparo.head
// Início da missão inteira, preservado entre retomadas: define o que a suíte final cobre.
const INICIO_MISSAO = retomar ? (retomar.inicioMissao ?? retomar.base) : preparo.head
if (retomar && !retomar.inicioMissao) {
  log(`retomar sem inicioMissao: a suíte final vai cobrir só a partir de ${retomar.base}, não a missão inteira`)
}

// Como a Factory: antes de começar, guias específicos por tipo de feature, montados a partir do código atual.
phase('Skills')
const plano = pendentes.filter(m => !m.suite).map(m =>
  `## ${m.titulo} (critério: ${m.criterio})\n` + m.features.map(f => `- ${f.titulo}: ${f.spec}`).join('\n'),
).join('\n\n')
// Retomando só a suíte final não há feature a guiar: pula o agente de skills.
const geradas = !plano ? null : await comRetentativa('skills da missão', () => agent(
  'Você prepara as skills desta missão. Leia o plano abaixo e o código que ele toca. Agrupe as features por tipo ' +
  `de trabalho (ex.: ${CONFIG.exemplosSkills}) e escreva um guia curto ` +
  'por tipo: arquivos-modelo do repo para copiar o padrão, onde cada peça mora, comando do teste focado e armadilhas ' +
  'já visíveis no código. Cite regras e skills existentes do projeto pelo caminho em vez de copiá-las. ' +
  'Cada feature do plano entra em exatamente uma skill, pelo título exato. Não escreva arquivos nem rode build ' +
  'ou testes: só leitura. ' + GIT_PROIBIDO + '\n\n' + plano,
  { label: 'skills da missão', phase: 'Skills', agentType: comoAgente(CONFIG.leitor), schema: SKILLS },
))
const skills = geradas?.skills ?? []
const guiaPorFeature = new Map()
for (const s of skills) for (const t of s.features) if (!guiaPorFeature.has(t)) guiaPorFeature.set(t, s)
const semSkill = pendentes.flatMap(m => m.features).filter(f => !guiaPorFeature.has(f.titulo)).map(f => f.titulo)
log(`${skills.length} skills geradas${semSkill.length ? `; sem skill: ${semSkill.join(', ')}` : ''}`)

const comGuia = (texto, lista) => lista.length
  ? `${texto}\n\nSkills desta missão (orientação; regras do repo prevalecem):\n` +
    lista.map(s => `### ${s.nome}\n${s.guia}`).join('\n\n') +
    '\n\nSe algum guia contrariar as proibições abaixo, as proibições vencem.\n' + GIT_PROIBIDO
  : texto

const mesmoSha = (a, b) => !!a && !!b && a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a))

// Caminhos relativos à raiz, com barra normal, como o `git diff --name-only` devolve. Agentes no Windows
// costumam devolver caminho absoluto (C:\...\arquivo) ou no formato do Git Bash (/c/...).
const unificar = a => a.trim().replace(/\\/g, '/').replace(/^\/([a-z])\//i, '$1:/')
function normalizar(a) {
  const c = unificar(a).replace(/^\.\//, '')
  const raiz = unificar(preparo.raiz).replace(/\/+$/, '')
  return c.toLowerCase().startsWith(raiz.toLowerCase() + '/') ? c.slice(raiz.length + 1) : c
}

function promptTrabalho(f, extra) {
  return comGuia(
    `Implemente a feature "${f.titulo}".\nSpec: ${f.spec}\n${extra}\n` +
    `${TESTES}, e revise o próprio diff.\n` + SAIDA_EM_ARQUIVO + '\n' +
    'NÃO faça commit nem stage: a revisão independente' +
    (CONFIG.regrasProjeto ? ` exigida pelo ${CONFIG.regrasProjeto}` : '') +
    ' é o próximo passo deste workflow e o commit vem depois dela. Não tente lançar revisor.\n' +
    'Devolva em `arquivos` todos os caminhos que você criou, alterou ou removeu, relativos à raiz do repositório ' +
    '(como o `git status` mostra).\n' +
    'Se o problema já estiver resolvido no código atual e não houver o que mudar, devolva concluida=true e jaResolvido=true.\n' +
    'Se não concluir, não descarte mudanças: devolva concluida=false explicando o bloqueio.\n' +
    GIT_PROIBIDO, f.guias ?? [])
}

// Commit só depois da revisão aprovada; este agente nunca altera código.
// Se cair depois de commitar, o commit é adotado apenas se for o único e tiver exatamente os arquivos da feature.
async function commitar(f, arquivos, fase, antes) {
  const chamar = () => agent(
    `Faça UM commit atômico da feature "${f.titulo}", já revisada e aprovada. Arquivos da feature: ${[...arquivos].join(', ')}.\n` +
    '- confira `git status`; se houver mudança em caminho fora dessa lista, não commite: devolva commitado=false e ' +
    'liste esses caminhos em foraDaLista;\n' +
    '- inclua exatamente os caminhos da lista (`git add -- <paths>`, nunca `git add -A`); caminho da lista que não ' +
    'aparece no `git status` (revertido no ajuste) é ignorado;\n' +
    `- mensagem ${CONFIG.formatoCommit} em ${CONFIG.idioma} descrevendo a feature, gravada em arquivo temporário FORA do repositório ` +
    '(ex.: saída de `mktemp`), usada com `git commit -F <arquivo> -- <paths>` e apagada depois;\n' +
    '- rode o commit com a saída em arquivo, nunca por pipe, porque os hooks rodam gates: ' +
    '`log=$(mktemp); git commit -F <arquivo> -- <paths> > "$log" 2>&1; echo "saida=$?"; tail -40 "$log"`;\n' +
    '- você NÃO altera código em hipótese alguma: se um gate do commit falhar, não corrija; devolva commitado=false, ' +
    'gateFalhou=true e a saída relevante em motivo;\n' +
    '- devolva o SHA completo (`git rev-parse HEAD`).\n' + SAIDA_EM_ARQUIVO + '\n' + GIT_PROIBIDO,
    { label: `commit: ${f.titulo}`, phase: fase, schema: RESULTADO_COMMIT, effort: 'low' },
  )
  let r = await chamar()
  for (let t = 1; !r && t <= MAX_RETENTATIVAS_INFRA; t++) {
    const c = await lerGit(antes, fase)
    if (!c) return { erro: 'agente de commit caiu e não foi possível ler o repositório' }
    if (c.commits.length > 0) {
      // A lista só cresce e pode ter caminho revertido; o commit adotado precisa estar contido nela.
      const mesmos = c.arquivos.length > 0 && c.arquivos.every(a => arquivos.has(normalizar(a)))
      if (c.branch === preparo.branch && c.limpo && c.commits.length === 1 && mesmos) return { commit: c.commits[0] }
      return { erro: `agente de commit caiu deixando ${c.commits.length} commit(s) que não correspondem à feature revisada` }
    }
    log(`commit: ${f.titulo}: agente não retornou (queda ou pulo manual), tentativa ${t + 1} de ${MAX_RETENTATIVAS_INFRA + 1}`)
    r = await chamar()
  }
  if (!r) return { erro: `agente de commit não retornou após ${MAX_RETENTATIVAS_INFRA + 1} tentativas` }
  if (r.commitado && r.commit) return { commit: r.commit }
  if (r.gateFalhou) return { apontamento: `gate do commit falhou: ${r.motivo ?? 'sem saída'}` }
  if (r.foraDaLista?.length) {
    return { apontamento: `mudanças fora da lista da feature: ${r.foraDaLista.join(', ')}. Se forem desta feature, ` +
      'declare-as em arquivos; se não, desfaça só elas' }
  }
  return { erro: r.motivo ?? 'commit não realizado' }
}

// Em série, como na Mission: cada feature parte do commit da anterior.
// Por feature: worker implementa sem commitar → revisor independente → ajustes até aprovar → commit.
// Limitação: o Workflow não continua conversa, então cada rodada tem um revisor novo, que recebe os apontamentos
// anteriores (o ideal seria o mesmo revisor continuar a conversa).
async function implementar(features, fase) {
  const resultados = []
  const commits = []
  for (const f of features) {
    const antes = head
    const falhou = motivo => ({ falhou: { feature: f.titulo, motivo }, resultados, commits })
    const sujo = ' O diff da feature ficou sem commit: descarte-o para a retomada repetir a feature, ou commite à mão ' +
      'e ajuste retomar.head, retomar.commits e retomar.concluidas.'
    // Worker que caiu: repete se não houve commit nem troca de branch. Se deixou diff parcial, o próximo continua dele.
    let parcial = false
    const r = await comRetentativa(f.titulo, () => agent(promptTrabalho(f, parcial
      ? '\nUma tentativa anterior caiu no meio: o diff não commitado atual é trabalho parcial desta feature. Continue a ' +
        'partir dele e declare em `arquivos` também os caminhos que ela já tinha alterado (veja `git status`).'
      : ''),
      { label: f.titulo, phase: fase, schema: RESULTADO_FEATURE },
    ), async () => {
      const c = await lerGit(antes, fase)
      if (!c) return { ok: false, semLeitura: true }
      if (c.branch !== preparo.branch || !mesmoSha(c.head, antes) || c.commits.length > 0) {
        return { ok: false, motivo: `branch ${c.branch}, HEAD ${c.head}, ${c.commits.length} commit(s) novo(s)` }
      }
      if (!c.limpo) parcial = true
      return { ok: true }
    })
    if (r?.semRetentativa) {
      const e = r.semRetentativa
      return falhou(e.semLeitura
        ? 'agente caiu e não foi possível ler o repositório para decidir se era seguro repetir'
        : `agente caiu e mexeu no histórico (${e.motivo}). Desfaça isso para repetir a feature`)
    }
    if (!r) return falhou(`agente não retornou após ${MAX_RETENTATIVAS_INFRA + 1} tentativas.${sujo}`)
    if (!r.concluida) return falhou(r.resumo + sujo)
    const arquivos = new Set((r.arquivos ?? []).map(normalizar))
    if (arquivos.size === 0) {
      // Só correção pode sair sem mudança; feature original precisa entregar algo.
      if (r.jaResolvido && fase === 'Corrigir') {
        resultados.push({ feature: f.titulo, ...r })
        continue
      }
      return falhou(r.jaResolvido ? 'feature original voltou sem mudança (jaResolvido)' : 'worker não declarou arquivos alterados.' + sujo)
    }

    let anteriores = []
    let rodada = 0
    let commit = null
    while (!commit) {
      const memoria = anteriores.length
        ? `\nNa rodada anterior foram apontados: ${anteriores.join(' | ')}. Confirme se foram resolvidos.`
        : ''
      const rev = await comRetentativa(`revisão: ${f.titulo}`, () => agent(
        `Revisão independente, antes do commit, da feature "${f.titulo}". Spec: ${f.spec}\n` +
        'Todo o diff ainda não commitado é desta feature: veja `git status`, `git diff HEAD` (inclui o que estiver em ' +
        'stage) e os arquivos novos. Aponte só problemas bloqueantes de correção, segurança, contrato ou testes faltantes.' +
        memoria + '\nSomente leitura. ' + SAIDA_EM_ARQUIVO + '\n' + GIT_PROIBIDO,
        { label: `revisão: ${f.titulo}`, phase: fase, agentType: revisorPara([...arquivos]), schema: VALIDACAO },
      ))
      if (!rev) return falhou('revisor da feature não respondeu.' + sujo)
      let problemas
      if (rev.aprovado) {
        const c = await commitar(f, arquivos, fase, antes)
        if (c.commit) { commit = c.commit; break }
        if (c.erro) return falhou(c.erro + '.' + sujo)
        problemas = [c.apontamento]
      } else {
        if (rev.problemas.length === 0) return falhou('revisão da feature reprovou sem apontar problemas.' + sujo)
        problemas = rev.problemas.map(p => `${p.arquivo ?? ''} ${p.problema}`.trim())
      }
      rodada++
      if (rodada > MAX_RODADAS_REVISAO) {
        return falhou(`revisão da feature não fechou após ${MAX_RODADAS_REVISAO} rodadas de ajuste: ${problemas.join(' | ')}.${sujo}`)
      }
      log(`${f.titulo}: ${problemas.length} apontamentos antes do commit → ajuste ${rodada}`)
      const ajuste = await comRetentativa(`${f.titulo} · ajuste ${rodada}`, () => agent(promptTrabalho(f,
        `\nO diff atual, ainda não commitado, já implementa esta feature. Ajuste-o conforme os apontamentos:\n- ` +
        problemas.join('\n- ') +
        '\nSe um gate falhar por causa fora desta feature (ambiente, dívida de outro código), não mexa em arquivos ' +
        'alheios: devolva concluida=false explicando.'),
        { label: `${f.titulo} · ajuste ${rodada}`, phase: fase, schema: RESULTADO_FEATURE },
      ))
      if (!ajuste) return falhou(`agente de ajuste não retornou após ${MAX_RETENTATIVAS_INFRA + 1} tentativas.${sujo}`)
      if (!ajuste.concluida) return falhou(ajuste.resumo + sujo)
      for (const a of ajuste.arquivos ?? []) arquivos.add(normalizar(a))
      anteriores = problemas
    }

    head = commit
    commits.push(commit)
    resultados.push({ feature: f.titulo, ...r, commit, rodadasRevisao: rodada })
  }
  return { resultados, commits }
}

// Lê o estado real do git, sem depender do relato dos workers.
function lerGit(base, fase) {
  return comRetentativa('conferência', () => agent(
    `Sem alterar nada, rode: \`git branch --show-current\`, \`git rev-parse HEAD\`, \`git status --porcelain\`, ` +
    `\`git rev-list --reverse ${base}..HEAD\` e \`git diff --name-only ${base}..HEAD\`. Devolva os SHAs completos.\n` +
    GIT_PROIBIDO,
    { label: 'conferência', phase: fase, agentType: comoAgente(CONFIG.leitor), schema: CONFERENCIA, effort: 'low' },
  ))
}

// Confere que o intervalo tem exatamente os commits declarados.
async function conferir(base, esperados, fase = 'Validar') {
  const c = await lerGit(base, fase)
  if (!c) return { ok: false, semLeitura: true, motivo: 'conferência não retornou' }
  if (c.branch !== preparo.branch) return { ok: false, motivo: `branch mudou para "${c.branch}"` }
  if (!c.limpo) return { ok: false, motivo: 'árvore com mudanças não commitadas' }
  if (!mesmoSha(c.head, head)) return { ok: false, motivo: `HEAD real ${c.head} difere do declarado ${head}` }
  const bate = c.commits.length === esperados.length && c.commits.every((s, i) => mesmoSha(s, esperados[i]))
  if (!bate) return { ok: false, motivo: `commits do intervalo não batem com os declarados (real: ${c.commits.length}, declarados: ${esperados.length}); pode haver commit extra ou de outra sessão` }
  return { ok: true, arquivos: c.arquivos }
}

// Suíte completa do projeto, no HEAD atual, sem alterar código.
async function validarSuite(anteriores) {
  const memoria = anteriores.length
    ? `\nNa rodada anterior falharam: ${anteriores.map(p => p.problema).join(' | ')}. Confirme se foram resolvidos.`
    : ''
  const intervalo = `${INICIO_MISSAO}..HEAD`
  const como = CONFIG.suiteCompleta
    ? `Rode a suíte completa do que a missão tocou e de quem depende disso: ${CONFIG.suiteCompleta.replaceAll('{inicio}', INICIO_MISSAO)}. ` +
      `Intervalo da missão: ${intervalo}.`
    : `Rode a suíte completa do que a missão tocou e de quem depende disso. Veja o que mudou com \`git diff --name-only ${intervalo}\`, ` +
      'identifique os módulos, pacotes ou apps tocados e os que dependem deles, e rode a suíte inteira de cada um ' +
      '(não só testes focados), com os runners já adotados no projeto.'
  const r = await comRetentativa('suíte completa', () => agent(
    `${como} Faça isso no HEAD atual, sem alterar código. ${SAIDA_EM_ARQUIVO} ` +
    'Não rode comandos que alterem lockfiles ou dependências versionadas. Confira `git status` antes e depois: ao ' +
    'terminar, desfaça somente o que a própria suíte criou ou alterou (remova arquivos novos gerados por ela e use ' +
    '`git restore -- <path>` nos que ela modificou), deixando a árvore como estava. Esses arquivos são seus, não ' +
    'alheios: a proibição de restore abaixo não se aplica a eles.\n' +
    'Aprove só se tudo passar. Agrupe as falhas por causa provável: um problema por causa, não um por teste, com o ' +
    'arquivo provável e a saída relevante. Se a causa for de ambiente (serviço fora do ar, dependência ou ferramenta ' +
    'ausente, porta ocupada), marque ambiente=true e descreva o que faltou.' + memoria +
    '\n' + GIT_PROIBIDO,
    { label: 'suíte completa', phase: 'Suíte final', schema: VALIDACAO },
  ))
  if (!r) return { erro: 'o agente da suíte completa não respondeu' }
  if (!r.aprovado && r.problemas.length === 0) return { erro: 'suíte completa reprovou sem apontar problemas' }
  // Ambiente não se corrige com código: para e devolve ao usuário em vez de gerar correção.
  const deAmbiente = r.problemas.filter(p => p.ambiente)
  if (!r.aprovado && deAmbiente.length) {
    return { erro: `a suíte completa não roda por causa do ambiente: ${deAmbiente.map(p => p.problema).join(' | ')}. ` +
      'Ajuste o ambiente e retome' }
  }
  return { aprovado: r.aprovado, problemas: r.problemas }
}

// Dois validadores independentes sobre os commits do milestone, como os 2 runs da Factory.
async function validar(m, base, arquivos, anteriores) {
  if (m.suite) return validarSuite(anteriores)
  const intervalo = `${base}..${head}`
  const memoria = anteriores.length
    ? `\nNa rodada anterior foram apontados: ${anteriores.map(p => p.problema).join(' | ')}. ` +
      'Confirme se foram resolvidos e só aponte novo problema se for bloqueante real.'
    : ''
  const [revisao, testes] = await parallel([
    () => comRetentativa(`revisão: ${m.titulo}`, () => agent(
      `Revise os commits ${intervalo} do milestone "${m.titulo}" (critério: ${m.criterio}). ` +
      'Aponte só problemas bloqueantes de correção, segurança, contrato ou atomicidade dos commits.' + memoria +
      '\nSomente leitura. ' + SAIDA_EM_ARQUIVO + '\n' + GIT_PROIBIDO,
      { label: `revisão: ${m.titulo}`, phase: 'Validar', agentType: revisorPara(arquivos.map(normalizar)), schema: VALIDACAO },
    )),
    () => comRetentativa(`testes: ${m.titulo}`, () => agent(
      `Rode, no HEAD atual, os testes focados que cobrem os commits ${intervalo} do milestone "${m.titulo}" ` +
      `e confira o critério: ${m.criterio}. Não altere código. Reporte falhas com a saída relevante.` + memoria +
      '\n' + SAIDA_EM_ARQUIVO + '\n' + GIT_PROIBIDO,
      { label: `testes: ${m.titulo}`, phase: 'Validar', schema: VALIDACAO },
    )),
  ])
  if (!revisao || !testes) return { erro: 'um validador não respondeu' }
  const problemas = [...revisao.problemas, ...testes.problemas]
  const aprovado = revisao.aprovado && testes.aprovado
  if (!aprovado && problemas.length === 0) return { erro: 'validação reprovou sem apontar problemas' }
  return { aprovado, problemas }
}

const relatorio = []

// `retomar` vai direto para args.retomar de uma nova execução: recomeça neste milestone, sem refazer o que já foi commitado.
// head e commits são só os que esta missão declarou; commit órfão de worker que caiu fica de fora de propósito.
function parar(m, base, feitas, commits, extra, jaConcluidas = []) {
  const concluidas = [...jaConcluidas, ...feitas.map(x => x.feature)]
  return {
    parouEm: m.titulo, ...extra, skills,
    retomar: { aPartirDe: m.titulo, branch: preparo.branch, inicioMissao: INICIO_MISSAO, base, head, commits: [...commits], concluidas },
    relatorio: [...relatorio, { milestone: m.titulo, commits: `${base}..${head}`, features: feitas }],
  }
}

for (const [i, m] of pendentes.entries()) {
  const retomando = i === 0 && retomar
  const base = retomando ? retomar.base : head
  const jaConcluidas = retomando ? retomar.concluidas ?? [] : []
  const feitas = []
  const commits = retomando ? [...retomar.commits] : []
  if (retomando) {
    // Só retoma se o repositório está exatamente como a execução anterior deixou: nada de commit alheio no intervalo.
    const c = await lerGit(base, 'Preparar')
    const esperado = retomar.commits
    const intacto = c && c.branch === preparo.branch && (!retomar.branch || c.branch === retomar.branch) && mesmoSha(c.head, retomar.head) && mesmoSha(c.head, head) &&
      c.commits.length === esperado.length && c.commits.every((s, j) => mesmoSha(s, esperado[j])) &&
      (esperado.length > 0 || mesmoSha(base, head))
    if (!intacto) {
      // Devolve o `retomar` recebido, intacto, para o usuário ajustar e tentar de novo.
      return { ...parar(m, base, feitas, [], {
        motivo: c
          ? `repositório mudou desde a parada (branch ${c.branch}, esperada ${retomar.branch ?? preparo.branch}; HEAD ${c.head}, esperado ${retomar.head}; ${c.commits.length} commits em ` +
            `${base}..HEAD, esperados ${esperado.length}). Desfaça as mudanças ou, se forem da missão, atualize ` +
            'retomar.head, retomar.commits e retomar.concluidas antes de retomar'
          : 'não foi possível ler o repositório para retomar',
      }, jaConcluidas), retomar }
    }
    log(`Retomando "${m.titulo}" sobre ${base}: ${esperado.length} commits anteriores, ${jaConcluidas.length} itens ` +
      `concluídos; orçamento de correções recomeça em ${MAX_RODADAS_CORRECAO} rodadas`)
  }
  const aFazer = m.features.filter(f => !jaConcluidas.includes(f.titulo))
  log(m.suite ? 'Suíte completa do projeto' : `Milestone: ${m.titulo} (${aFazer.length} de ${m.features.length} features a implementar)`)
  const pararAqui = extra => parar(m, base, feitas, commits, extra, jaConcluidas)
  const features = aFazer.map(f => ({ ...f, guias: guiaPorFeature.has(f.titulo) ? [guiaPorFeature.get(f.titulo)] : [] }))
  // Correção pode tocar qualquer parte do milestone: recebe todas as skills dele.
  // Na suíte final a falha pode estar em qualquer parte da missão: todas as skills.
  const guiasDoMilestone = m.suite ? skills
    : [...new Set(m.features.filter(f => guiaPorFeature.has(f.titulo)).map(f => guiaPorFeature.get(f.titulo)))]

  const impl = await implementar(features, 'Implementar')
  feitas.push(...impl.resultados)
  commits.push(...impl.commits)
  if (impl.falhou) return pararAqui(impl.falhou)

  let conf = await conferir(base, commits)
  if (!conf.ok) return pararAqui({ motivo: conf.motivo })
  let v = await validar(m, base, conf.arquivos, [])
  if (v.erro) return pararAqui({ motivo: v.erro })

  let rodada = 0
  let semProgresso = null
  while (!v.aprovado && rodada < MAX_RODADAS_CORRECAO) {
    rodada++
    if (v.problemas.length > MAX_PROBLEMAS_POR_RODADA) {
      return pararAqui({ motivo: `${v.problemas.length} problemas numa rodada (limite ${MAX_PROBLEMAS_POR_RODADA}); revise o plano`, problemas: v.problemas })
    }
    log(`${m.titulo}: ${v.problemas.length} problemas → rodada de correção ${rodada}`)
    const todos = v.problemas.map(p => `${p.arquivo ?? ''} ${p.problema}`.trim())
    const correcoes = todos.map((p, i) => ({
      titulo: `correção ${rodada}.${i + 1} (${m.titulo})`,
      spec: `Corrija: ${p}\n${m.suite ? 'Falha da suíte completa ao fim da missão' : `Milestone "${m.titulo}", critério: ${m.criterio}, commits ${base}..${head}`}.\n` +
        `Outros problemas da mesma rodada (podem ser duplicados deste ou já corrigidos): ${todos.filter((_, j) => j !== i).join(' | ') || 'nenhum'}.\n` +
        'Corrija a causa: não desative, pule nem enfraqueça testes, e não mexa em limites de cobertura para passar.',
      guias: guiasDoMilestone,
    }))
    const fix = await implementar(correcoes, 'Corrigir')
    feitas.push(...fix.resultados)
    commits.push(...fix.commits)
    if (fix.falhou) return pararAqui(fix.falhou)

    conf = await conferir(base, commits)
    if (!conf.ok) return pararAqui({ motivo: conf.motivo })
    const anterior = v.problemas
    v = await validar(m, base, conf.arquivos, anterior)
    if (v.erro) return pararAqui({ motivo: v.erro })
    if (!v.aprovado && v.problemas.length >= anterior.length) {
      semProgresso = { antes: anterior.length, depois: v.problemas.length }
      break
    }
  }

  if (!v.aprovado) {
    const motivo = semProgresso
      ? `sem progresso na rodada ${rodada}: ${semProgresso.antes} problemas antes, ${semProgresso.depois} depois`
      : `não fechou após ${MAX_RODADAS_CORRECAO} rodadas`
    log(`Parando em "${m.titulo}": ${motivo}`)
    return pararAqui({ motivo, problemas: v.problemas })
  }
  // Os validadores rodam depois da última conferência: confirma que não sujaram a árvore nem commitaram.
  conf = await conferir(base, commits)
  if (!conf.ok) return pararAqui({ motivo: `após validação: ${conf.motivo}` })

  relatorio.push({ milestone: m.titulo, aprovado: true, rodadasCorrecao: rodada, commits: `${base}..${head}`, features: feitas })
}

return { concluido: true, branch: preparo.branch, base: INICIO_MISSAO, head, skills, relatorio }
