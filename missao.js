export const meta = {
  name: 'missao',
  description: 'Executa uma SPEC ou um plano em milestones: features em série com commit atômico, validação, caça bug e correções, parando se não fechar',
  whenToUse: 'Trabalho grande em milestones e features (estilo Factory Missions). Passe o plano em args.milestones, ou a SPEC em args.spec para a missão conferir a simplicidade e planejar; para retomar, passe em args.retomar o objeto devolvido na parada. Agente pulado é retentado: use maxRetentativasInfra 0 para evitar.',
  phases: [
    { title: 'Preparar', detail: 'confere árvore limpa, branch e HEAD base pelo script de estado do git' },
    { title: 'Simplicidade', detail: 'só com spec: confere a simplicidade da SPEC; pergunta ou corte para a missão' },
    { title: 'Planejar', detail: 'só com spec: gera o plano em milestones, que volta no retomar' },
    { title: 'Pré-voo', detail: 'confere se o ambiente roda testes e suíte antes de qualquer commit' },
    { title: 'Contexto', detail: 'contexto do plano por área, gerado uma vez e reaproveitado na retomada' },
    { title: 'Contrato', detail: 'por milestone: confere no código do dono as premissas das features' },
    { title: 'UI/UX', detail: 'milestone com tela: desenha telas e fluxos com checklist de UX, sem esperar aprovação' },
    { title: 'Implementar', detail: 'por feature, em série: implementa, revisão independente, commit' },
    { title: 'Scrutiny', detail: 'confere commits; testes, lint, typecheck e revisão contra o critério do milestone' },
    { title: 'Corrigir', detail: 'um item por problema apontado, com revisão e commit próprios' },
    { title: 'Caça bug', detail: 'caçador por área; cada achado com 2 verificadores; confirmado vira correção' },
    { title: 'User testing', detail: 'só com jornada no plano: percorre como usuário na stack local' },
    { title: 'Suíte final', detail: 'caça final entre milestones e suíte completa do projeto; falhas viram correções' },
    { title: 'Aceite', detail: 'liga cada critério de aceite a uma evidência; sem evidência vira correção uma vez' },
  ],
}

// claude-missao: núcleo genérico. Num projeto, este arquivo é gerado por `instalar.mjs` com a configuração do
// projeto embutida em CONFIG_PROJETO; edite no repositório claude-missao, não na cópia instalada.
//
// args: { milestones: [{ titulo, criterio, caca?, userTesting?, features: [{ titulo, spec }] }] } (ou plano: { milestones })
//       ou { spec } (texto ou caminho da SPEC: a missão confere a simplicidade e gera o plano), mais
//       maxRodadasCorrecao?, maxProblemasPorRodada?, maxRodadasRevisao?, maxFeaturesPorMilestone?, maxRetentativasInfra?,
//       maxRodadasCaca?, aceite?, modo? ('enxugar': cortar código que já existe; também pelo marcador na SPEC), retomar?,
//       config?
// Etapas: [simplicidade e plano, só com spec] → pré-voo → contexto do plano → por milestone: prova de contrato,
// features (implementa → revisão independente → commit atômico conferido), scrutiny ⇄ correções, caça bug ⇄ correções,
// user testing ⇄ correções → caça final entre milestones → suíte completa ⇄ correções → aceite.
// O git é lido pelo script git-estado.mjs, nunca pela interpretação de um modelo. Commit de outra sessão nunca para a
// missão: é aceito; o que toca arquivo dela volta ao scrutiny e à caça, e o que levou o diff da feature a conclui.
// Correções seguem enquanto a avaliação aponta menos problemas que na rodada anterior; o teto só evita loop infinito.
// Prompt de etapa = técnica da etapa (etapas/<etapa>.md, embutida na instalação) + contexto do plano + aprendizados.
// O contexto do plano é gerado uma vez por missão e volta no retomar; os aprendizados dos workers se acumulam nele.
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
  // agentType read-only para o contexto do plano e a conferência do git (ex.: 'explorer'). null: agente padrão.
  leitor: null,
  // Proibições extras além das de git. Ex.: ['variáveis MEUPROJETO_SKIP_*']
  proibicoesExtras: [],
  // Formato e idioma da mensagem de commit.
  formatoCommit: '`<tipo>: <descrição>`',
  idioma: 'pt-BR',
  // Exemplos de áreas de trabalho para o agente que monta o contexto do plano.
  exemplosSkills: 'migration + entidade, endpoint com teste de integração, tela',
  // Como rodar, ao fim da missão, a suíte completa do que a missão tocou e de quem depende disso (comando ou
  // instrução; {inicio} vira o commit onde a missão começou). null: o agente descobre módulos tocados e dependentes.
  suiteCompleta: null,
  // O que o pré-voo confere antes de qualquer commit: comandos e requisitos da suíte e dos testes (ex.: Docker vivo,
  // WSL com pwsh para suítes só-Linux). null: o agente descobre pelo plano e pelo projeto.
  preVoo: null,
  // Modelo do agente que só roda o script de estado do git e devolve a saída literal.
  modeloConferencia: 'haiku',
}
// @config-inicio (substituído por instalar.mjs)
const CONFIG_PROJETO = {}
// @config-fim
// Técnica curta de cada etapa, embutida por instalar.mjs a partir de etapas/<etapa>.md e do complemento do projeto em
// .claude/missao/etapas/: o script do Workflow não lê arquivos. No núcleo cru fica vazio.
// @etapas-inicio (substituído por instalar.mjs)
const ETAPAS = {}
// @etapas-fim
// Aprendizados duráveis do projeto, embutidos por instalar.mjs a partir de .claude/missao/aprendizados.md. Vão em todo
// prompt de etapa, antes dos aprendizados desta execução. No núcleo cru fica vazio.
// @aprendizados-inicio (substituído por instalar.mjs)
const APRENDIZADOS_PROJETO = ''
// @aprendizados-fim
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
  for (const k of ['regrasTestes', 'regrasProjeto', 'revisor', 'leitor', 'suiteCompleta', 'preVoo']) if (!texto(CONFIG[k])) erros.push(`${k} deve ser texto ou null`)
  for (const k of ['formatoCommit', 'idioma', 'exemplosSkills', 'modeloConferencia']) if (typeof CONFIG[k] !== 'string') erros.push(`${k} deve ser texto`)
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
const MAX_RODADAS_CACA = args?.maxRodadasCaca ?? 3

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

// Árvore suja não para a missão: cada commit leva só os arquivos que o worker declarou. O que já estava sujo no
// preparo (sujeiraInicial) e o que outras sessões deixam na árvore ficam onde estão, fora dos commits.
// Caminhos das linhas do `git status --porcelain` (renomeação conta os dois lados).
function caminhosPendentes(c) {
  return (c.pendencias ?? []).flatMap(l => {
    const p = l.replace(/\r$/, '').slice(3).trim()
    return p.includes(' -> ') ? p.split(' -> ') : [p]
  }).map(p => normalizar(p.replace(/^"|"$/g, ''))).filter(Boolean)
}

const RESULTADO_FEATURE = {
  type: 'object',
  properties: {
    concluida: { type: 'boolean' },
    jaResolvido: { type: 'boolean' },
    arquivos: { type: 'array', items: { type: 'string' } },
    resumo: { type: 'string' },
    aprendizados: { type: 'array', items: { type: 'string' }, maxItems: 3 },
    testesRodados: { type: 'array', items: { type: 'string' } },
    // Mudanças novas na árvore que o worker diz não ter feito (outra sessão): viram sujeira alheia.
    naoSao: { type: 'array', items: { type: 'string' } },
    // Mensagem do commit da feature, no formato e idioma do projeto; a missão a usa no commit.
    mensagem: { type: 'string' },
  },
  required: ['concluida', 'resumo'],
}

// O agente de commit só roda o comando pronto e devolve a saída literal.
const RESULTADO_COMMIT = {
  type: 'object',
  properties: { saida: { type: 'string' }, recusado: { type: 'boolean' }, motivo: { type: 'string' } },
  required: [],
}

// Script instalado no projeto pelo instalar.mjs (fonte: git-estado.mjs no claude-missao).
const GIT_ESTADO = '.claude/missao/git-estado.mjs'
// Última saída inválida do script (ex.: erro do git), para a parada mostrar a causa real.
let erroGit = null
const causaGit = () => (erroGit ? `; última saída de ${GIT_ESTADO}: ${erroGit}` : '')
// O agente de conferência só devolve a saída literal do script de estado do git; quem a interpreta é o workflow.
const SAIDA = { type: 'object', properties: { saida: { type: 'string' } }, required: ['saida'] }

// Todo worker pode devolver fatos não óbvios que descobriu; eles se acumulam no contexto da missão.
const APRENDIZADOS = { type: 'array', items: { type: 'string' }, maxItems: 3 }

const CONTEXTO = {
  type: 'object',
  properties: {
    areas: {
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
  required: ['areas'],
}

const VALIDACAO = {
  type: 'object',
  properties: {
    aprendizados: APRENDIZADOS,
    aprovado: { type: 'boolean' },
    problemas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          arquivo: { type: 'string' }, problema: { type: 'string' }, ambiente: { type: 'boolean' },
          // user testing: desvio de UX ou de aderência ao desenho.
          ux: { type: 'boolean' },
        },
        required: ['problema'],
      },
    },
  },
  required: ['aprovado', 'problemas'],
}

const SIMPLICIDADE = {
  type: 'object',
  properties: {
    aprendizados: APRENDIZADOS,
    ok: { type: 'boolean' },
    perguntas: { type: 'array', items: { type: 'string' } },
    cortes: { type: 'array', items: { type: 'string' } },
  },
  required: ['ok', 'perguntas', 'cortes'],
}

const PLANO = {
  type: 'object',
  properties: {
    aprendizados: APRENDIZADOS,
    milestones: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          titulo: { type: 'string' },
          criterio: { type: 'string' },
          caca: { type: 'array', items: { type: 'string' } },
          userTesting: { type: 'string' },
          ui: { type: 'string' },
          features: {
            type: 'array',
            items: { type: 'object', properties: { titulo: { type: 'string' }, spec: { type: 'string' } }, required: ['titulo', 'spec'] },
          },
        },
        required: ['titulo', 'criterio', 'features'],
      },
    },
  },
  required: ['milestones'],
}

// Medição do alvo no modo enxugar: no pré-voo (antes) e no aceite (depois).
const MEDICAO = {
  type: 'object',
  properties: {
    linhas: { type: 'integer' }, tabelas: { type: 'integer' }, filas: { type: 'integer' }, arquivos: { type: 'integer' },
    testes: { type: 'integer' }, comandos: { type: 'string' },
  },
}

const PRE_VOO = {
  type: 'object',
  properties: {
    aprendizados: APRENDIZADOS, ok: { type: 'boolean' }, faltando: { type: 'array', items: { type: 'string' } }, medicao: MEDICAO,
  },
  required: ['ok', 'faltando'],
}

// Plano: args.milestones (ou args.plano.milestones) direto; na retomada, o que voltou em retomar.plano. Só com
// args.spec, a missão verifica a simplicidade da SPEC e gera o plano antes de começar.
const SPEC = typeof args?.spec === 'string' && args.spec.trim() ? args.spec.trim() : null
const planoDado = args?.milestones ?? args?.plano?.milestones ?? args?.retomar?.plano?.milestones ?? null
const limitesOk = [MAX_RODADAS_CORRECAO, MAX_PROBLEMAS_POR_RODADA, MAX_RODADAS_REVISAO, MAX_FEATURES_POR_MILESTONE, MAX_RODADAS_CACA].every(n => Number.isInteger(n) && n >= 1) &&
  Number.isInteger(MAX_RETENTATIVAS_INFRA) && MAX_RETENTATIVAS_INFRA >= 0
// Modo enxugar: cortar um código que já existe. Vem de args.modo, do retomar ou do marcador na SPEC em texto.
const MARCA_ENXUGAR = '<!-- modo: enxugar -->'
const modoValido = v => v === undefined || v === null || v === 'enxugar'
const modoOk = args?.modo !== null && modoValido(args?.modo) && modoValido(args?.retomar?.modo)
const MODO = args?.modo ?? args?.retomar?.modo ?? (SPEC?.includes(MARCA_ENXUGAR) ? 'enxugar' : null)
const aceiteOk = args?.aceite === undefined || (Array.isArray(args.aceite) && args.aceite.every(x => typeof x === 'string'))
if (!args || !limitesOk || !aceiteOk || !modoOk || (!planoDado && !SPEC)) {
  throw new Error('args inválido: { milestones: [{ titulo, criterio, caca?, userTesting?, features: [{ titulo, spec }] }] } ou ' +
    '{ spec }, com maxRodadasCorrecao?, maxProblemasPorRodada?, maxRodadasRevisao?, maxFeaturesPorMilestone?, ' +
    'maxRetentativasInfra?, maxRodadasCaca?, aceite?: [critérios], modo?: "enxugar", retomar?; limites inteiros ≥ 1 e retentativas ≥ 0')
}

// A suíte completa roda uma vez ao fim, como uma etapa sem features: falha vira correção no mesmo loop.
const SUITE = { titulo: 'Suíte final', criterio: 'a suíte completa do projeto passa', features: [], suite: true }
const repetidosEm = lista => [...new Set(lista.filter((t, i) => lista.indexOf(t) !== i))]
// Por que o plano não serve, ou null. Vale para o plano passado e para o gerado a partir da SPEC.
function erroDoPlano(ms) {
  const textos = v => Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim())
  const forma = Array.isArray(ms) && ms.length > 0 && ms.every(m => m && m.titulo && m.criterio &&
    Array.isArray(m.features) && m.features.length > 0 && m.features.every(f => f && f.titulo && f.spec) &&
    (m.caca === undefined || textos(m.caca)) && (m.userTesting === undefined || typeof m.userTesting === 'string') && (m.ui === undefined || typeof m.ui === 'string'))
  if (!forma) {
    return 'plano inválido: milestones: [{ titulo, criterio, caca?: [áreas], userTesting?: jornada, ui?: telas, features: [{ titulo, spec }] }], sem listas vazias'
  }
  const featuresRepetidas = repetidosEm(ms.flatMap(m => m.features.map(f => f.titulo)))
  if (featuresRepetidas.length) return `títulos de feature repetidos: ${featuresRepetidas.join(', ')}`
  const milestonesRepetidos = repetidosEm(ms.map(m => m.titulo))
  if (milestonesRepetidos.length) return `títulos de milestone repetidos: ${milestonesRepetidos.join(', ')}`
  const grandes = ms.filter(m => m.features.length > MAX_FEATURES_POR_MILESTONE)
  if (grandes.length) {
    return `milestones acima de ${MAX_FEATURES_POR_MILESTONE} features (divida em milestones menores ou ` +
      `ajuste maxFeaturesPorMilestone): ${grandes.map(m => `${m.titulo} (${m.features.length})`).join(', ')}`
  }
  if (ms.some(m => m.titulo === SUITE.titulo)) return `"${SUITE.titulo}" é reservado; renomeie o milestone`
  return null
}
if (planoDado) {
  const erro = erroDoPlano(planoDado)
  if (erro) throw new Error(erro)
}

const retomar = args.retomar ?? null
if (retomar && (!planoDado || ![...planoDado, SUITE].some(m => m.titulo === retomar.aPartirDe) ||
  typeof retomar.base !== 'string' || retomar.base.length < 7 ||
  typeof retomar.head !== 'string' || retomar.head.length < 7 || !Array.isArray(retomar.commits) ||
  (retomar.concluidas !== undefined && !Array.isArray(retomar.concluidas)) ||
  (retomar.inicioMissao !== undefined && (typeof retomar.inicioMissao !== 'string' || retomar.inicioMissao.length < 7)))) {
  throw new Error('args.retomar inválido: use o objeto `retomar` devolvido pela execução que parou ({ aPartirDe, inicioMissao, base, head, commits, concluidas, plano, contexto })')
}

// Contexto da missão: áreas do plano (hidratação, gerada uma vez) e aprendizados dos workers. Volta no retomar.
const contexto = { areas: [], aprendizados: [] }
// Estado da missão que atravessa a retomada: caça final já feita e bugs que a caça confirmou e a missão corrigiu.
let cacaFinalFeita = retomar?.cacaFinalFeita === true
const bugsCorrigidos = Array.isArray(retomar?.bugsCorrigidos) ? retomar.bugsCorrigidos.filter(b => typeof b === 'string') : []
if (retomar?.contexto) {
  const lista = v => (Array.isArray(v) ? v : [])
  contexto.areas = lista(retomar.contexto.areas)
}
// Aprendizado é técnica ou armadilha durável; o filtro barra excesso e repetição, o prompt barra estado do momento.
const MAX_APRENDIZADOS_POR_WORKER = 3
const normalizarAprendizado = t => t.toLowerCase().replace(/^[-*]\s*/, '').replace(/[\s.;:]+$/, '').trim()
const jaNoProjeto = new Set(APRENDIZADOS_PROJETO.split('\n').map(normalizarAprendizado).filter(Boolean))
function aprender(r) {
  const novos = (Array.isArray(r?.aprendizados) ? r.aprendizados : [])
    .map(a => (typeof a === 'string' ? a.trim() : '')).filter(Boolean)
  if (novos.length > MAX_APRENDIZADOS_POR_WORKER) {
    log(`${novos.length - MAX_APRENDIZADOS_POR_WORKER} aprendizado(s) acima do limite de ${MAX_APRENDIZADOS_POR_WORKER} por agente descartado(s)`)
  }
  for (const t of novos.slice(0, MAX_APRENDIZADOS_POR_WORKER)) {
    const n = normalizarAprendizado(t)
    if (jaNoProjeto.has(n) || contexto.aprendizados.some(a => normalizarAprendizado(a) === n)) continue
    contexto.aprendizados.push(t)
  }
  return r
}
// Os do retomar passam pelo mesmo filtro, sem o limite por agente: o aprendizados.md pode ter crescido desde a parada.
for (const t of Array.isArray(retomar?.contexto?.aprendizados) ? retomar.contexto.aprendizados : []) {
  const n = typeof t === 'string' ? normalizarAprendizado(t) : ''
  if (n && !jaNoProjeto.has(n) && !contexto.aprendizados.some(a => normalizarAprendizado(a) === n)) contexto.aprendizados.push(t.trim())
}
// Texto pronto para o agente pai revisar e acrescentar ao .claude/missao/aprendizados.md do projeto, sem o que já está lá.
function sugestaoAprendizados() {
  const novos = contexto.aprendizados.filter(a => !jaNoProjeto.has(normalizarAprendizado(a)))
  return novos.length ? `${novos.map(a => `- ${a}`).join('\n')}\n` : null
}
// Agente que trabalha, revisa ou valida: o que ele aprende entra no contexto dos próximos prompts.
const trabalhar = async (prompt, opt) => aprender(await agent(prompt, opt))
const APRENDER = `Em aprendizados, devolva só técnica ou armadilha durável, que valha para a próxima missão (comando ` +
  '"rode os testes com forks=1", limite de ferramenta, comportamento não óbvio de outro serviço como "o serviço X ' +
  'devolve 404 sem acesso"), numa frase cada. Nunca estado do momento: HEAD, contagem de testes, "já está feito", ' +
  `resultado desta rodada. No máximo ${MAX_APRENDIZADOS_POR_WORKER}; sem nada durável, lista vazia.`

// Prompt de etapa = técnica da etapa (etapas/<etapa>.md, embutida pelo instalador) + trecho pertinente do contexto do
// plano + aprendizados + a tarefa.
function montar(etapa, tarefa, areas = []) {
  const partes = []
  if (ETAPAS[etapa]) partes.push(`Técnica da etapa ${etapa} (orientação; regras do repo prevalecem):\n${ETAPAS[etapa]}`)
  // No modo enxugar, o complemento etapas/<etapa>.enxugar.md ajusta a técnica para código que já existe.
  if (MODO === 'enxugar' && ETAPAS[`${etapa}.enxugar`]) partes.push(`Modo enxugar (código existente):\n${ETAPAS[`${etapa}.enxugar`]}`)
  if (areas.length) partes.push('Contexto do plano (orientação; regras do repo prevalecem):\n' + areas.map(s => `### ${s.nome}\n${s.guia}`).join('\n\n'))
  if (APRENDIZADOS_PROJETO) partes.push(`Aprendizados do projeto:\n${APRENDIZADOS_PROJETO}`)
  if (contexto.aprendizados.length) partes.push(`Aprendizados desta missão:\n- ${contexto.aprendizados.join('\n- ')}`)
  const final = `${tarefa}\n${APRENDER}`
  return partes.length ? `${partes.join('\n\n')}\n\nSe algo acima contrariar as proibições da tarefa, as proibições vencem.\n\n${final}` : final
}
const SPEC_NO_PROMPT = () => `SPEC (texto, ou caminho de arquivo no repositório para ler inteiro):\n${SPEC}`

// agent() devolve null quando o modelo/API cai; nas Missions da Factory quase toda falha de worker foi assim.
// antesDeRetentar confirma que repetir é seguro; se não for, devolve { semRetentativa: estado }.
// Pular um agente manualmente também produz null: para interromper de fato, rode com maxRetentativasInfra 0. Exceção:
// a leitura do git (lerGit) sempre repete ao menos uma vez, porque saída inválida é ruído do agente, não queda.
// max: teto de retentativas desta chamada (padrão maxRetentativasInfra).
async function comRetentativa(rotulo, chamar, antesDeRetentar, max = MAX_RETENTATIVAS_INFRA) {
  let r = await chamar()
  for (let t = 1; !r && t <= max; t++) {
    if (antesDeRetentar) {
      const estado = await antesDeRetentar()
      if (!estado.ok) return { semRetentativa: estado }
    }
    log(`${rotulo}: agente não retornou (queda ou pulo manual), tentativa ${t + 1} de ${max + 1}`)
    r = await chamar()
  }
  return r
}

phase('Preparar')
const preparo = await lerGit('HEAD', 'Preparar', 'preparo')
if (!preparo || !preparo.branch) {
  return {
    parouEm: 'preparo',
    motivo: preparo ? 'HEAD destacado; a missão precisa de uma branch' : `não foi possível ler o git no preparo${causaGit()}`,
  }
}
log(`Branch ${preparo.branch}, base ${preparo.head}`)
// Linha de base: mudanças não commitadas que já existiam (na retomada, somadas às da parada). Ignoradas pela missão;
// arquivo dela que um worker editar vai inteiro no commit e vira aviso em sujeiraCommitada.
// O diff da feature que ficou sem commit na parada (retomar.arquivosPendentes) é da missão, não linha de base.
const pendentesDaParada = Array.isArray(retomar?.arquivosPendentes) ? retomar.arquivosPendentes : []
const sujeiraInicial = [...new Set([
  ...(Array.isArray(retomar?.sujeiraInicial) ? retomar.sujeiraInicial.filter(a => typeof a === 'string') : []),
  ...caminhosPendentes(preparo).filter(a => !pendentesDaParada.includes(a)),
])]
// Sujeira alheia já vista: linha de base, mais o que sobra na árvore fora da lista depois de cada commit e a cada
// conferência. Mudança nova fora disso e fora da lista do worker volta para ele antes do commit.
const sujeiraVista = new Set(sujeiraInicial)
if (sujeiraInicial.length) log(`árvore com ${sujeiraInicial.length} mudança(s) não commitada(s) de antes: ficam fora dos commits (${sujeiraInicial.slice(0, 10).join(', ')})`)
const sujeiraCommitada = Array.isArray(retomar?.sujeiraCommitada) ? [...retomar.sujeiraCommitada] : []

let head = preparo.head
// Início da missão inteira, preservado entre retomadas: define o que a suíte final cobre.
const INICIO_MISSAO = retomar ? (retomar.inicioMissao ?? retomar.base) : preparo.head
if (retomar && !retomar.inicioMissao) {
  log(`retomar sem inicioMissao: a suíte final vai cobrir só a partir de ${retomar.base}, não a missão inteira`)
}

// Só com a SPEC: antes de qualquer código, confere a simplicidade e gera o plano. Pergunta ou corte sugerido para a
// missão e volta tudo junto para o usuário decidir.
let milestones = planoDado
if (!milestones) {
  phase('Simplicidade')
  const s = await comRetentativa('simplicidade', () => trabalhar(montar('verificar-simplicidade',
    `${SPEC_NO_PROMPT()}\n\nLeia a SPEC e o código que ela toca e confira a simplicidade dela. Devolva em perguntas o ` +
    'que precisa de decisão do usuário e em cortes o que sugere tirar ou trocar por algo mais simples, cada item com ' +
    'o motivo e a evidência no código. Sem perguntas nem cortes, ok=true. Não escreva arquivos nem rode build: só ' +
    'leitura.\n' + GIT_PROIBIDO),
    { label: 'simplicidade', phase: 'Simplicidade', agentType: comoAgente(CONFIG.leitor), schema: SIMPLICIDADE },
  ))
  if (!s) return { parouEm: 'simplicidade', motivo: 'o agente que verifica a simplicidade não respondeu', aprendizados: contexto.aprendizados, sugestaoAprendizados: sugestaoAprendizados() }
  if (!s.ok || s.perguntas.length || s.cortes.length) {
    return {
      parouEm: 'simplicidade',
      motivo: 'a verificação de simplicidade trouxe perguntas ou cortes: decida, ajuste a SPEC e rode de novo (nenhum código foi escrito)',
      perguntas: s.perguntas, cortes: s.cortes, aprendizados: contexto.aprendizados, sugestaoAprendizados: sugestaoAprendizados(),
    }
  }
  phase('Planejar')
  const p = await comRetentativa('planejar', () => trabalhar(montar('planejar',
    `${SPEC_NO_PROMPT()}\n\nA SPEC foi aprovada. Leia-a e o código que ela toca e gere o plano: milestones com titulo, ` +
    `criterio verificável, caca (áreas de caça-bug do milestone), userTesting (a jornada, só se houver uma que um ` +
    `usuário percorre; senão omita), ui (as telas e fluxos de usuário do milestone, só se houver; senão omita) e features com titulo único e spec. No máximo ${MAX_FEATURES_POR_MILESTONE} ` +
    `features por milestone; o título "${SUITE.titulo}" é reservado. Não escreva arquivos nem rode build: só leitura.\n` +
    GIT_PROIBIDO),
    { label: 'planejar', phase: 'Planejar', agentType: comoAgente(CONFIG.leitor), schema: PLANO },
  ))
  // Campo opcional vazio conta como ausente.
  const gerado = p?.milestones?.map(m => ({ ...m, caca: m.caca?.length ? m.caca : undefined, userTesting: m.userTesting?.trim() || undefined, ui: m.ui?.trim() || undefined }))
  const erro = gerado ? erroDoPlano(gerado) : 'o agente de planejamento não respondeu'
  if (erro) return { parouEm: 'planejar', motivo: `plano gerado não serve: ${erro}`, plano: p ?? null, aprendizados: contexto.aprendizados, sugestaoAprendizados: sugestaoAprendizados() }
  milestones = JSON.parse(JSON.stringify(gerado))
  log(`Plano gerado: ${milestones.length} milestones, ${milestones.reduce((n, m) => n + m.features.length, 0)} features`)
}

const etapas = [...milestones, SUITE]
const inicio = retomar ? etapas.findIndex(m => m.titulo === retomar.aPartirDe) : 0
const pendentes = etapas.slice(inicio)
if (inicio > 0) log(`Retomando em "${retomar.aPartirDe}": ${inicio} etapas anteriores já entregues`)
const planoTexto = pendentes.filter(m => !m.suite).map(m =>
  `## ${m.titulo} (critério: ${m.criterio})\n` + m.features.map(f => `- ${f.titulo}: ${f.spec}`).join('\n'),
).join('\n\n')

const totalFeatures = pendentes.reduce((n, m) => n + m.features.length, 0)
// preparo, pré-voo, conferência da retomada e contexto (se não veio do retomar); por feature: worker, revisão, leitura do
// git antes do commit, commit e conferência; por
// milestone: prova de contrato, 2 conferências, 2 validadores, caça (um caçador por área, mais o agente que deriva as
// áreas se o plano não as traz), UI/UX (desenho, ou o agente que detecta se há tela) e user testing se houver jornada; fim: caça final (com 2+ milestones, fora da
// retomada na suíte), 2 conferências, suíte e aceite
const porMilestone = m => 6 + (m.caca ? m.caca.length : 2) + (m.userTesting ? 1 : 0)
const estimativa = 2 + (retomar ? 1 : 0) + (contexto.areas.length || !planoTexto ? 0 : 1) + 5 * totalFeatures +
  pendentes.filter(m => !m.suite).reduce((n, m) => n + porMilestone(m), 0) +
  (milestones.length > 1 && !cacaFinalFeita ? 1 : 0) + 4
log(`Estimativa mínima: ${estimativa} agentes a partir daqui (sem contar correções e retentativas)`)

const relatorio = []
// Commits de fora (de outra sessão ou automação), sempre aceitos e levados no retomar: não contam como da missão.
const deForaAceitos = Array.isArray(args.retomar?.deFora) ? args.retomar.deFora.filter(s => typeof s === 'string') : []
// Os que tocam arquivo da missão, por milestone ({ milestone, commits, arquivos }): voltam ao scrutiny e à caça do
// milestone, à caça final e à suíte, e saem no relatório final.
const deForaTocando = Array.isArray(retomar?.deForaTocando)
  ? retomar.deForaTocando.filter(d => d && typeof d.milestone === 'string' && Array.isArray(d.commits) && Array.isArray(d.arquivos))
  : []
// Critérios de aceite com a evidência de cada um, preenchidos ao fim.
let aceite = null
// Modo enxugar: medição do alvo no início (pré-voo, preservada na retomada) e no fim (aceite).
let medicaoAntes = retomar?.medicaoAntes ?? null
// A medição inicial tirada na retomada (ou que faltou) não é o "antes" de verdade: vai marcada como parcial.
let antesParcial = retomar?.antesParcial === true
let medicaoDepois = null
// Desenho de UI/UX por milestone (título → { ui, links, texto, desvios } ou { semTela: true }), levado no retomar para a
// retomada não redesenhar. Nunca para a missão: o usuário revisa os desenhos no fim, em resultado.designs.
const designs = { ...(retomar?.designs && typeof retomar.designs === 'object' ? retomar.designs : {}) }
const listaDesigns = () => Object.entries(designs).filter(([, d]) => d && !d.semTela)
  .map(([milestone, d]) => ({ milestone, links: d.links ?? [], texto: d.texto ?? '', desvios: d.desvios ?? [] }))
function blocoDesign(titulo) {
  const d = designs[titulo]
  if (!d || d.semTela || (!d.texto && !d.links?.length)) return ''
  return `\nDesenho de UI/UX do milestone (siga-o nas telas e fluxos de usuário):\n${d.texto}` +
    (d.links?.length ? `\nLinks do desenho: ${d.links.join(' ')}` : '') +
    (ETAPAS['ui-ux'] ? `\n${ETAPAS['ui-ux']}` : '') +
    (MODO === 'enxugar' && ETAPAS['ui-ux.enxugar'] ? `\n${ETAPAS['ui-ux.enxugar']}` : '')
}
const MEDIR = 'Meça também o alvo desta missão e devolva em medicao: linhas de código (sem testes), tabelas vivas, ' +
  'filas/listeners, arquivos e testes, e em medicao.comandos os comandos que usou.'

// Antes de qualquer commit: o ambiente roda o que a suíte e os testes vão precisar? Roda também na retomada.
phase('Pré-voo')
const preVoo = await comRetentativa('pré-voo', () => trabalhar(montar('pre-voo',
  'Confira se o ambiente roda o que esta missão vai precisar para os testes focados e a suíte final' +
  (CONFIG.preVoo ? `: ${CONFIG.preVoo}` : ': descubra pelo plano abaixo e pelo projeto os runners de teste, build e serviços de apoio') +
  `.\nNão altere código nem arquivos versionados. ${SAIDA_EM_ARQUIVO}\n` +
  'Devolva ok=true só se tudo o que a missão vai usar funciona; senão, em faltando, cada item que falta, com como ' +
  `conferir e como resolver.${MODO === 'enxugar' && !medicaoAntes ? `\n${MEDIR}` : ''}\n${GIT_PROIBIDO}\n\n${planoTexto}`),
  { label: 'pré-voo', phase: 'Pré-voo', schema: MODO === 'enxugar' && !medicaoAntes ? { ...PRE_VOO, required: [...PRE_VOO.required, 'medicao'] } : PRE_VOO },
))
if (!preVoo || !preVoo.ok) {
  const motivo = preVoo
    ? `o ambiente não está pronto: ${preVoo.faltando.join(' | ') || 'sem detalhe'}. Ajuste o ambiente e rode de novo`
    : 'o agente de pré-voo não respondeu'
  // Parada antes de qualquer commit: devolve o retomar recebido ou um que recomeça no primeiro milestone.
  const r = retomar ?? parar(pendentes[0], head, [], [], {}).retomar
  return { parouEm: 'pré-voo', motivo, faltando: preVoo?.faltando ?? [], plano: { milestones }, contexto, aprendizados: contexto.aprendizados, sugestaoAprendizados: sugestaoAprendizados(), retomar: r }
}

if (MODO === 'enxugar' && !medicaoAntes) {
  medicaoAntes = preVoo.medicao ?? null
  antesParcial = !!retomar || !medicaoAntes
  if (antesParcial) log('modo enxugar: medição inicial ausente ou tirada na retomada; o antes x depois sai marcado como parcial')
}

// Hidratação, como a Factory: o contexto do plano (guias por área, montados a partir do código atual) é gerado UMA vez
// por missão e volta no `retomar`; a retomada o reaproveita, junto com os aprendizados, em vez de regenerá-lo.
phase('Contexto')
// Só reaproveita contexto com áreas: parada no pré-voo, ou agente de contexto que caiu, deixa o contexto vazio.
if (contexto.areas.length) {
  log('Contexto do plano reaproveitado da execução anterior')
} else if (planoTexto) {
  const gerado = await comRetentativa('contexto do plano', () => agent(
    'Você prepara o contexto do plano desta missão. Leia o plano abaixo e o código que ele toca. Agrupe as features ' +
    `por área de trabalho (ex.: ${CONFIG.exemplosSkills}) e escreva um guia curto por área: arquivos-modelo do repo ` +
    'para copiar o padrão, onde cada peça mora, comando do teste focado e armadilhas já visíveis no código. Cite ' +
    'regras e skills existentes do projeto pelo caminho em vez de copiá-las. Cada feature do plano entra em ' +
    'exatamente uma área, pelo título exato. Não escreva arquivos nem rode build ou testes: só leitura. ' +
    GIT_PROIBIDO + '\n\n' + planoTexto,
    { label: 'contexto do plano', phase: 'Contexto', agentType: comoAgente(CONFIG.leitor), schema: CONTEXTO },
  ))
  contexto.areas = gerado?.areas ?? []
}
const guiaPorFeature = new Map()
for (const s of contexto.areas) for (const t of s.features ?? []) if (!guiaPorFeature.has(t)) guiaPorFeature.set(t, s)
const semArea = pendentes.flatMap(m => m.features).filter(f => !guiaPorFeature.has(f.titulo)).map(f => f.titulo)
log(`${contexto.areas.length} áreas no contexto do plano${semArea.length ? `; sem área: ${semArea.join(', ')}` : ''}`)

const mesmoSha = (a, b) => !!a && !!b && a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a))

// Caminhos relativos à raiz, com barra normal, como o `git diff --name-only` devolve. Agentes no Windows
// costumam devolver caminho absoluto (C:\...\arquivo) ou no formato do Git Bash (/c/...).
function unificar(a) { return a.trim().replace(/\\/g, '/').replace(/^\/([a-z])\//i, '$1:/') }
function normalizar(a) {
  const c = unificar(a).replace(/^\.\//, '')
  const raiz = unificar(preparo.raiz).replace(/\/+$/, '')
  return c.toLowerCase().startsWith(raiz.toLowerCase() + '/') ? c.slice(raiz.length + 1) : c
}
// Pasta nova aparece no `git status` como `novo/`: declarada assim, cobre os arquivos de dentro.
const naLista = (arquivos, a) => arquivos.has(a) || [...arquivos].some(p => p.endsWith('/') && a.startsWith(p))

function promptTrabalho(f, extra) {
  return montar(f.etapa ?? 'implementar',
    `Implemente a feature "${f.titulo}".\nSpec: ${f.spec}\n${extra}${blocoDesign(f.milestone)}\n` +
    `${TESTES}, e revise o próprio diff.\n` + SAIDA_EM_ARQUIVO + '\n' +
    'Não rode `git commit`, `git add`, `git stash`, `git reset` nem `git checkout -- .`: quem commita é a missão, ' +
    'com a lista que você devolver, depois da revisão independente' +
    (CONFIG.regrasProjeto ? ` exigida pelo ${CONFIG.regrasProjeto}` : '') +
    ' é o próximo passo deste workflow e o commit vem depois dela. Não tente lançar revisor.\n' +
    'Devolva em `arquivos` todos os caminhos que você criou, alterou ou removeu, relativos à raiz do repositório ' +
    '(como o `git status` mostra); em renomeação (`git mv`), declare origem e destino. Devolva em `mensagem` a mensagem ' +
    `do commit da feature, ${CONFIG.formatoCommit} em ${CONFIG.idioma}.` +
    ' A árvore pode ter mudanças de antes da missão ou de outras sessões: não as mexa ' +
    'nem as declare, salvo o que esta feature precisar mudar.\n' +
    'Se o problema já estiver resolvido no código atual e não houver o que mudar, devolva concluida=true e jaResolvido=true.\n' +
    'Se não concluir, não descarte mudanças: devolva concluida=false explicando o bloqueio.\n' +
    GIT_PROIBIDO, f.guias ?? [])
}

// Commit só depois da revisão aprovada, e o worker nunca commita. O commit é um passo fixo da missão: o comando sai
// pronto daqui, com os caminhos da lista que têm mudança, e o agente barato só o executa e devolve a saída literal.
// Nunca `git add -A` nem `.`: o que não está na lista fica fora. Devolve { commit }, { apontamento } (commit falhou,
// vira ajuste), { verificar, parar? } (a conferência a seguir decide) ou { erro }.
const aspas = p => `'${String(p).replace(/'/g, `'\\''`)}'`
// Mensagem: a que o worker escreveu no formato do projeto; sem ela, uma mínima a partir do título.
function comandoDeCommit(f, caminhos, escrita) {
  const mensagem = String(escrita ?? '').replace(/^MSG_MISSAO$/gm, '').trim() ||
    `${f.etapa === 'corrigir' ? 'fix' : 'feat'}: ${f.titulo}`
  const lista = caminhos.map(aspas).join(' ')
  return 'log=$(mktemp); msg=$(mktemp); cat > "$msg" <<\'MSG_MISSAO\'\n' + mensagem + '\nMSG_MISSAO\n' +
    `git add -- ${lista} > "$log" 2>&1 && git commit -F "$msg" -- ${lista} >> "$log" 2>&1; ` +
    'echo "saida=$?"; tail -60 "$log"; echo "head=$(git rev-parse HEAD)"; rm -f "$msg" "$log"'
}
async function commitar(f, caminhos, fase, antes, mensagem) {
  const comando = comandoDeCommit(f, caminhos, mensagem)
  const chamar = () => agent(
    `Commit da feature "${f.titulo}", já revisada e aprovada. Rode exatamente o comando abaixo, uma vez, no Bash, na raiz ` +
    'do repositório, e devolva em saida a saída literal e completa. Não rode mais nada, não altere o comando e não ' +
    'tente corrigir nada se ele falhar. Se o harness ou o classificador de permissões recusar o comando, não tente de ' +
    'outro jeito: devolva recusado=true e o texto da recusa em motivo.\n\n' + comando,
    { label: `commit: ${f.titulo}`, phase: fase, schema: RESULTADO_COMMIT, model: CONFIG.modeloConferencia, effort: 'low' },
  )
  let r = await chamar()
  for (let t = 1; !r && t <= MAX_RETENTATIVAS_INFRA; t++) {
    const c = await lerGit(antes, fase)
    if (!c) return { erro: 'agente de commit caiu e não foi possível ler o repositório' }
    // Caiu com commit no intervalo (o dela ou de outra sessão): a conferência a seguir classifica os commits.
    if (c.commits.length > 0) return { verificar: true, motivo: 'o agente de commit caiu' }
    log(`commit: ${f.titulo}: agente não retornou (queda ou pulo manual), tentativa ${t + 1} de ${MAX_RETENTATIVAS_INFRA + 1}`)
    r = await chamar()
  }
  if (!r) return { erro: `agente de commit não retornou após ${MAX_RETENTATIVAS_INFRA + 1} tentativas` }
  // Recusa não se contorna: a decisão é humana. A conferência a seguir diz se o commit chegou a ser feito.
  if (r.recusado) return { verificar: true, parar: `o harness recusou o comando de commit, e a missão não contorna recusa: ${r.motivo ?? 'sem texto'}` }
  const texto = String(r.saida ?? '')
  const codigo = /saida=(\d+)/.exec(texto)?.[1]
  const sha = /head=([0-9a-f]{7,40})/i.exec(texto)?.[1] ?? null
  if (codigo === '0' && sha) return { commit: sha }
  // Commit que falhou com saída (gate do hook, por exemplo) vira ajuste, como antes; sem saída reconhecível, a
  // conferência vê se o diff já foi commitado.
  if (codigo && codigo !== '0') return { apontamento: `o commit falhou (gate ou hook): ${texto.slice(-2000)}` }
  return { verificar: true, motivo: `saída do commit não reconhecida: ${texto.slice(0, 300)}` }
}

// Commits reais que a missão não fez, quando todos os dela estão lá: vieram de outra sessão ou automação.
function commitsDeFora(c, esperados) {
  if (!esperados.every(e => c.commits.some(s => mesmoSha(s, e)))) return []
  return c.commits.filter(s => !esperados.some(e => mesmoSha(s, e)))
}
// Arquivos que a missão commitou (na retomada, recuperados do git) e os do milestone atual: base para julgar commit de
// fora.
const arquivosDaMissao = new Set()
let arquivosDoMilestone = new Set()

// Commit de outra sessão ou automação nunca para a missão: é aceito e não conta como dela. Se toca arquivo da
// missão, fica registrado em deForaTocando para o scrutiny e a caça revisarem esses arquivos. emCurso: arquivos da
// feature ainda não conferida.
function aceitarCommitsDeFora(c, deFora, milestone, emCurso = []) {
  const daMissao = new Set([...arquivosDaMissao, ...arquivosDoMilestone, ...emCurso])
  const tocados = [...new Set(deFora.flatMap(s => (c.arquivosPorCommit?.[s] ?? []).map(normalizar)).filter(a => naLista(daMissao, a)))]
  deForaAceitos.push(...deFora)
  if (!tocados.length) return log(`commit de fora aceito, não toca a missão: ${deFora.join(', ')}`)
  deForaTocando.push({ milestone, commits: [...deFora], arquivos: tocados })
  log(`commit de fora aceito, toca a missão: ${deFora.join(', ')}. O commit de fora toca arquivo da missão: ${tocados.join(', ')}`)
}
// Arquivos da missão tocados por commit de fora, para quem revisa. milestone null: todos (caça final e suíte).
function reviseDeFora(milestone = null) {
  const d = deForaTocando.filter(x => milestone === null || x.milestone === milestone)
  if (!d.length) return ''
  return ` Arquivos da missão tocados por commit de fora: ${d.map(x => `${x.arquivos.join(', ')} (${x.commits.join(', ')})`).join('; ')}. ` +
    'Revise-os: outra sessão mexeu neles no meio da missão.'
}

// A missão não decide pelo usuário se fica um commit que ela não revisou: diz como aceitá-lo na retomada.
const aceitar = headReal => 'ponha em retomar.commits a saída de `git rev-list --reverse <retomar.base>..HEAD` e em ' +
  `retomar.head o HEAD real, ${headReal}`

// Logo depois do commit de cada feature, classifica os commits de `antes..HEAD` que ainda não foram aceitos como de fora:
// - da feature: todos os arquivos na lista revisada (o commit do agente ou um que o próprio worker fez);
// - de fora: nenhum arquivo na lista; aceito e registrado, nunca para a missão;
// - misto: arquivo da feature junto de arquivo que a revisão não viu; fica fora do retomar e a missão para.
// Sujeira na árvore, da linha de base ou de outras sessões, não conta. Devolve { daFeature, novos, head },
// { semCommit, motivo } quando nada da feature foi commitado, ou { motivo, naoAdotar?, naoLido? }.
async function fecharCommit(f, antes, arquivos, fase, declarado = null) {
  const c = await lerGit(antes, fase)
  if (!c) {
    return { naoLido: true, motivo: `a conferência logo depois do commit de "${f.titulo}" não retornou` +
      `${declarado ? `; o commit declarado, ${declarado}, entrou em retomar sem ser conferido` : ''}${causaGit()}` }
  }
  if (c.branch !== preparo.branch) return { motivo: `branch mudou para "${c.branch}" logo depois do commit de "${f.titulo}"` }
  if (declarado && !c.commits.some(s => mesmoSha(s, declarado))) {
    return { naoAdotar: true, motivo: `o agente de commit declarou ${declarado}, mas ${antes}..HEAD tem ` +
      `${c.commits.join(', ') || 'nenhum commit'}; confira o git e ajuste retomar à mão` }
  }
  const arquivosDe = s => (c.arquivosPorCommit?.[s] ?? []).map(normalizar)
  const daFeature = []
  const deFora = []
  const mistos = []
  for (const s of c.commits.filter(s => !deForaAceitos.some(d => mesmoSha(d, s)))) {
    const todos = arquivosDe(s)
    const naFeature = todos.filter(a => naLista(arquivos, a))
    if (todos.length && naFeature.length === todos.length) daFeature.push(s)
    else if (!naFeature.length) deFora.push(s)
    else mistos.push(s)
  }
  if (mistos.length) {
    const alheios = [...new Set(mistos.flatMap(arquivosDe).filter(a => !naLista(arquivos, a)))]
    return { naoAdotar: true, motivo: `o commit de "${f.titulo}", ${mistos.join(', ')}, tem arquivos fora da lista revisada: ` +
      `${alheios.join(', ')}. Ele ficou fora do retomar. Para aceitá-lo, ${aceitar(c.head)}, e inclua "${f.titulo}" em ` +
      'retomar.concluidas; para recusá-lo, tire-o do histórico e retome sem mudar o retomar, e a feature se repete' }
  }
  if (deFora.length) aceitarCommitsDeFora(c, deFora, f.milestone, [...arquivos])
  // O que sobrou na árvore fora da lista da feature é sujeira alheia já vista.
  for (const p of caminhosPendentes(c)) if (!naLista(arquivos, p)) sujeiraVista.add(p)
  // Arquivo da lista ainda pendente depois do commit: o commit não levou tudo (ou só o worker commitou uma parte).
  const faltando = caminhosPendentes(c).filter(a => naLista(arquivos, a))
  if (!daFeature.length) return { semCommit: true, faltando, motivo: `nenhum commit com o diff da feature "${f.titulo}" em ${antes}..HEAD` }
  // Arquivo que já estava sujo antes da missão e que o worker editou foi inteiro no commit: aviso, não parada.
  const jaSujos = [...new Set(daFeature.flatMap(arquivosDe).filter(a => sujeiraInicial.includes(a)))]
  if (jaSujos.length) {
    sujeiraCommitada.push({ feature: f.titulo, commit: daFeature.at(-1), arquivos: jaSujos })
    // Já commitado, o arquivo deixa de ser sujeira de antes: os próximos commits dele não repetem o aviso.
    for (const a of jaSujos) sujeiraInicial.splice(sujeiraInicial.indexOf(a), 1)
    log(`aviso: "${f.titulo}" commitou inteiro arquivo que já tinha mudança antes da missão: ${jaSujos.join(', ')}`)
  }
  if (daFeature.length > 1 || (declarado && !mesmoSha(daFeature.at(-1), declarado))) {
    log(`"${f.titulo}": commits com o diff da feature além do agente de commit: ${daFeature.join(', ')}; todos com arquivos da lista revisada`)
  }
  return { daFeature, faltando, novos: c.commits, head: c.head }
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
    let arquivos = new Set()
    const falhou = motivo => ({ falhou: { feature: f.titulo, motivo, arquivosPendentes: [...arquivos] }, resultados, commits })
    const sujo = ' O diff da feature ficou sem commit: descarte-o para a retomada repetir a feature, ou commite à mão ' +
      'e ajuste retomar.head, retomar.commits e retomar.concluidas.'
    // Worker que caiu: repete, mesmo com commit novo no intervalo (de outra sessão, ou dele: a conferência depois do
    // commit os classifica). Só para se a branch mudou ou o histórico foi reescrito. Diff parcial: o próximo continua.
    let parcial = false
    const r = await comRetentativa(f.titulo, () => trabalhar(promptTrabalho(f, parcial
      ? '\nUma tentativa anterior caiu no meio: as mudanças não commitadas que não estavam na árvore antes dela ' +
        `(${[...sujeiraVista].join(', ') || 'nenhuma'}) são trabalho parcial desta feature. Continue a partir delas e ` +
        'declare em `arquivos` também os caminhos que ela já tinha alterado (veja `git status`).'
      : ''),
      { label: f.titulo, phase: fase, schema: RESULTADO_FEATURE },
    ), async () => {
      const c = await lerGit(antes, fase)
      if (!c) return { ok: false, semLeitura: true }
      if (c.branch !== preparo.branch) return { ok: false, motivo: `branch mudou para ${c.branch}` }
      if (!c.commits.length && !mesmoSha(c.head, antes)) return { ok: false, motivo: `HEAD ${c.head} não descende de ${antes}` }
      if (c.commits.length) log(`${f.titulo}: agente caiu com commit(s) novo(s) no intervalo (${c.commits.join(', ')}); repetindo, e a conferência depois do commit os classifica`)
      if (caminhosPendentes(c).some(a => !sujeiraVista.has(a))) parcial = true
      return { ok: true }
    })
    if (r?.semRetentativa) {
      const e = r.semRetentativa
      return falhou(e.semLeitura
        ? 'agente caiu e não foi possível ler o repositório para decidir se era seguro repetir'
        : `agente caiu e o histórico mudou (${e.motivo}). Confira o git e ajuste retomar à mão`)
    }
    if (!r) return falhou(`agente não retornou após ${MAX_RETENTATIVAS_INFRA + 1} tentativas.${sujo}`)
    if (!r.concluida) return falhou(r.resumo + sujo)
    arquivos = new Set((r.arquivos ?? []).map(normalizar))
    let mensagem = r.mensagem
    for (const a of (r.naoSao ?? []).map(normalizar)) sujeiraVista.add(a)
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
    let pos = null
    let declarado = null
    let pararDepois = null
    while (!pos) {
      const memoria = anteriores.length
        ? `\nNa rodada anterior foram apontados: ${anteriores.join(' | ')}. Confirme se foram resolvidos.`
        : ''
      const rev = await comRetentativa(`revisão: ${f.titulo}`, () => trabalhar(montar('revisar',
        `Revisão independente, antes do commit, da feature "${f.titulo}". Spec: ${f.spec}\n` +
        `O diff desta feature são os arquivos ${[...arquivos].join(', ')}: veja \`git diff ${antes} -- <esses caminhos>\` ` +
        '(inclui stage e o que já tiver sido commitado desde o início da feature) e os novos entre eles. Outras ' +
        'mudanças na árvore não são desta feature: ignore-as. ' +
        'Aponte só problemas bloqueantes de correção, segurança, contrato ou testes faltantes.' +
        (blocoDesign(f.milestone)
          ? `${blocoDesign(f.milestone)}\nConfira a aderência ao desenho e ao checklist de UX só das telas e fluxos que ESTA ` +
            'feature cria ou muda. O que outra feature do milestone ainda vai entregar (outra tela, um ponto de entrada em ' +
            'outra tela) não é achado desta revisão. Feature sem tela não tem achado de UX. Achado grave de UX nas telas ' +
            'desta feature (pedir ID ou UUID digitado à mão, ação destrutiva sem confirmação, tela nova sem ponto de ' +
            'entrada que ela mesma deveria criar) é bloqueante.'
          : '') +
        memoria + '\nSomente leitura. ' + SAIDA_EM_ARQUIVO + '\n' + GIT_PROIBIDO, f.guias ?? []),
        { label: `revisão: ${f.titulo}`, phase: fase, agentType: revisorPara([...arquivos]), schema: VALIDACAO },
      ))
      if (!rev) return falhou('revisor da feature não respondeu.' + sujo)
      let problemas = null
      if (rev.aprovado) {
        // Antes do commit: mudança nova na árvore que o worker não declarou (não estava na linha de base nem era sujeira
        // alheia já vista) volta para ele declarar ou desfazer, porque o commit só leva a lista.
        const c0 = await lerGit(antes, fase)
        if (!c0) return falhou(`não foi possível ler o repositório antes do commit${causaGit()}.${sujo}`)
        if (c0.branch !== preparo.branch) return falhou(`branch mudou para "${c0.branch}" antes do commit de "${f.titulo}"`)
        const naoDeclarados = caminhosPendentes(c0).filter(a => !sujeiraVista.has(a) && !naLista(arquivos, a))
        if (naoDeclarados.length) {
          problemas = [`mudanças novas na árvore fora da lista da feature: ${naoDeclarados.join(', ')}. Se forem desta ` +
            'feature (inclusive a origem de uma renomeação), declare-as em arquivos; se forem suas e não da feature, ' +
            'desfaça só elas; se não foram você que fez, não mexa e liste-as em naoSao']
        } else {
          // Só os caminhos da lista que têm mudança: o que o worker já commitou sozinho a conferência classifica.
          const caminhos = caminhosPendentes(c0).filter(a => naLista(arquivos, a))
          let cm = caminhos.length ? await commitar(f, caminhos, fase, antes, mensagem) : { verificar: true, motivo: 'nenhum arquivo da lista com mudança pendente' }
          if (cm.erro) return falhou(cm.erro + '.' + sujo)
          if (cm.apontamento) problemas = [cm.apontamento]
          else {
            declarado = cm.commit ?? null
            pararDepois = cm.parar ?? null
            pos = await fecharCommit(f, antes, arquivos, fase, declarado)
            // Commit de fora aceito, agente que não commitou ou commit parcial (do próprio worker), com arquivo da lista
            // ainda sem commit: commita o que falta, uma vez.
            if (!pararDepois && (pos.semCommit || !pos.motivo) && pos.faltando?.length) {
              log(`${f.titulo}: arquivos da lista ainda sem commit (${pos.faltando.join(', ')}); repetindo o commit`)
              cm = await commitar(f, pos.faltando, fase, antes, mensagem)
              if (cm.erro || cm.apontamento) return falhou(`${cm.erro ?? cm.apontamento}.${sujo}`)
              declarado = cm.commit ?? declarado
              pararDepois = cm.parar ?? null
              pos = await fecharCommit(f, antes, arquivos, fase, cm.commit ?? null)
            }
            if (pos.semCommit) return falhou(`${pararDepois ?? `o diff da feature não foi commitado (${cm.motivo ?? pos.motivo})`}.${sujo}`)
            if (!pos.motivo && pos.faltando?.length) return falhou(`o commit não levou todos os arquivos da lista: ${pos.faltando.join(', ')}.${sujo}`)
          }
        }
      } else {
        if (rev.problemas.length === 0) return falhou('revisão da feature reprovou sem apontar problemas.' + sujo)
        problemas = rev.problemas.map(p => `${p.arquivo ?? ''} ${p.problema}`.trim())
      }
      if (pos) break
      rodada++
      if (rodada > MAX_RODADAS_REVISAO) {
        return falhou(`revisão da feature não fechou após ${MAX_RODADAS_REVISAO} rodadas de ajuste: ${problemas.join(' | ')}.${sujo}`)
      }
      log(`${f.titulo}: ${problemas.length} apontamentos antes do commit → ajuste ${rodada}`)
      const ajuste = await comRetentativa(`${f.titulo} · ajuste ${rodada}`, () => trabalhar(promptTrabalho(f,
        `\nO diff atual, ainda não commitado, já implementa esta feature. Ajuste-o conforme os apontamentos:\n- ` +
        problemas.join('\n- ') +
        '\nSe um gate falhar por causa fora desta feature (ambiente, dívida de outro código), não mexa em arquivos ' +
        'alheios: devolva concluida=false explicando.'),
        { label: `${f.titulo} · ajuste ${rodada}`, phase: fase, schema: RESULTADO_FEATURE },
      ))
      if (!ajuste) return falhou(`agente de ajuste não retornou após ${MAX_RETENTATIVAS_INFRA + 1} tentativas.${sujo}`)
      if (!ajuste.concluida) return falhou(ajuste.resumo + sujo)
      for (const a of (ajuste.arquivos ?? []).map(normalizar)) arquivos.add(a)
      for (const a of (ajuste.naoSao ?? []).map(normalizar)) sujeiraVista.add(a)
      if (ajuste.mensagem) mensagem = ajuste.mensagem
      anteriores = problemas
    }

    // Conferência que não voltou: o commit declarado entra no retomar, sem ser conferido, como antes.
    const adotados = pos.daFeature ? pos.novos : pos.naoLido && declarado ? [declarado] : null
    if (adotados) {
      head = pos.head ?? declarado
      commits.push(...adotados)
      for (const a of arquivos) { arquivosDaMissao.add(a); arquivosDoMilestone.add(a) }
      const commit = pos.daFeature?.at(-1) ?? declarado
      resultados.push({ feature: f.titulo, ...r, commit, ...(pos.daFeature?.length > 1 ? { commitsDaFeature: pos.daFeature } : {}), rodadasRevisao: rodada })
      // Commitado, o diff da feature já não é pendência dela na retomada.
      arquivos = new Set()
    }
    if (pos.motivo) return falhou(pararDepois ? `${pararDepois}. ${pos.motivo}` : pos.motivo)
    if (pararDepois) return falhou(`${pararDepois}. O commit da feature, ${pos.daFeature?.at(-1) ?? declarado}, já entrou em retomar: decida à mão antes de retomar`)
  }
  return { resultados, commits }
}

// Lê o estado real do git sem depender do relato dos workers nem da leitura de um modelo: o agente só roda o script
// instalado e devolve a saída literal, que o workflow interpreta. Saída que não é o JSON esperado conta como queda e a
// leitura se repete; nunca vira apontamento.
function estadoDoGit(saida) {
  // O script imprime um objeto numa linha; cerca de código ou espaço que o agente ponha em volta não conta.
  const texto = String(saida ?? '')
  let c
  try {
    c = JSON.parse(texto.slice(texto.indexOf('{'), texto.lastIndexOf('}') + 1))
  } catch {
    return null
  }
  const lista = v => Array.isArray(v) && v.every(x => typeof x === 'string')
  const valido = c && typeof c === 'object' && ['head', 'branch', 'raiz'].every(k => typeof c[k] === 'string') &&
    typeof c.limpo === 'boolean' && lista(c.pendencias) && lista(c.commits) && lista(c.arquivos) &&
    (c.resumo === true
      // Modo compacto: arquivos da missão e do milestone já unidos pelo script, sem arquivosPorCommit.
      ? lista(c.arquivosDoMilestone) && c.contagem?.arquivosDoMilestone === c.arquivosDoMilestone.length
      : c.arquivosPorCommit && typeof c.arquivosPorCommit === 'object' &&
        Object.keys(c.arquivosPorCommit).length === c.commits.length && c.commits.every(s => lista(c.arquivosPorCommit[s]))) &&
    // A contagem que o script imprime denuncia lista resumida ou cortada por quem repassou a saída.
    c.contagem?.commits === c.commits.length && c.contagem?.arquivos === c.arquivos.length &&
    c.contagem?.pendencias === c.pendencias.length
  return valido ? c : null
}
// Lê ao menos duas vezes, mesmo com maxRetentativasInfra 0: saída inválida é ruído do agente, não queda.
// resumo: argumentos do modo compacto (--resumo <base do milestone> [<sha de fora>...]).
function lerGit(base, fase, label = 'conferência', resumo = '') {
  return comRetentativa(label, async () => {
    const r = await agent(
      `Rode exatamente \`node ${GIT_ESTADO} ${base}${resumo}\` na raiz do repositório e devolva em saida a saída padrão ` +
      'literal e completa, sem resumir, reordenar nem comentar. Não rode mais nada. Se o comando falhar, devolva o erro em saida.',
      { label, phase: fase, agentType: comoAgente(CONFIG.leitor), schema: SAIDA, model: CONFIG.modeloConferencia, effort: 'low' },
    )
    if (!r) return null
    const c = estadoDoGit(r.saida)
    if (!c) {
      erroGit = String(r.saida).trim().slice(0, 500)
      log(`${label}: saída de ${GIT_ESTADO} inválida (${erroGit}); repetindo a leitura`)
    }
    return c
  }, undefined, Math.max(MAX_RETENTATIVAS_INFRA, 1))
}

// Confere que o intervalo tem exatamente os commits declarados.
async function conferir(base, esperados, milestone, fase = 'Scrutiny') {
  const c = await lerGit(base, fase)
  if (!c) return { ok: false, semLeitura: true, motivo: `conferência não retornou${causaGit()}` }
  if (c.branch !== preparo.branch) return { ok: false, motivo: `branch mudou para "${c.branch}"` }
  const deFora = commitsDeFora(c, esperados)
  if (deFora.length) {
    aceitarCommitsDeFora(c, deFora, milestone)
    // Aceito: passa a ser esperado no milestone (a lista do chamador é atualizada aqui) e o HEAD anda até ele.
    esperados.splice(0, esperados.length, ...c.commits)
    head = c.head
  }
  for (const p of caminhosPendentes(c)) sujeiraVista.add(p)
  if (!mesmoSha(c.head, head)) return { ok: false, motivo: `HEAD real ${c.head} difere do declarado ${head}` }
  const bate = c.commits.length === esperados.length && c.commits.every((s, i) => mesmoSha(s, esperados[i]))
  if (!bate) return { ok: false, motivo: `commits do intervalo não batem com os declarados (real: ${c.commits.length}, declarados: ${esperados.length}); pode haver commit extra ou de outra sessão` }
  return { ok: true, arquivos: arquivosSemDeFora(c) }
}

// Commit de fora aceito não é trabalho da missão: fica fora do escopo de scrutiny, caça, correção e revisor por pasta.
const ehDeFora = s => deForaAceitos.some(d => mesmoSha(d, s))
function arquivosSemDeFora(c) {
  if (!c.commits.some(ehDeFora) || !c.arquivosPorCommit) return c.arquivos
  return [...new Set(c.commits.filter(s => !ehDeFora(s)).flatMap(s => c.arquivosPorCommit[s] ?? []))]
}
const semDeFora = () => deForaAceitos.length
  ? ` Ignore os commits de fora da missão (${deForaAceitos.join(', ')}): não são deste trabalho, nem os arquivos que só eles mudaram.`
  : ''

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
  const r = await comRetentativa('suíte completa', () => trabalhar(montar('scrutiny',
    `${como} Faça isso no HEAD atual, sem alterar código. ${SAIDA_EM_ARQUIVO} ` +
    'Não rode comandos que alterem lockfiles ou dependências versionadas. Confira `git status` antes e depois: ao ' +
    'terminar, desfaça somente o que a própria suíte criou ou alterou (remova arquivos novos gerados por ela e use ' +
    '`git restore -- <path>` nos que ela modificou), deixando a árvore como estava. Esses arquivos são seus, não ' +
    'alheios: a proibição de restore abaixo não se aplica a eles.\n' +
    'Aprove só se tudo passar. Agrupe as falhas por causa provável: um problema por causa, não um por teste, com o ' +
    'arquivo provável e a saída relevante. Se a causa for de ambiente (serviço fora do ar, dependência ou ferramenta ' +
    'ausente, porta ocupada), marque ambiente=true e descreva o que faltou.' + memoria +
    (deForaAceitos.length
      ? `\nOs commits ${deForaAceitos.join(', ')} são de fora da missão: não peça correção do código deles. Falha que ` +
        'venha só deles, descreva-a dizendo que é de fora da missão, para decisão humana.'
      : '') +
    reviseDeFora() +
    '\n' + GIT_PROIBIDO, contexto.areas),
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
    () => comRetentativa(`revisão: ${m.titulo}`, () => trabalhar(montar('scrutiny',
      `Revise os commits ${intervalo} do milestone "${m.titulo}" (critério: ${m.criterio}).${semDeFora()}${reviseDeFora(m.titulo)} ` +
      'Aponte só problemas bloqueantes de correção, segurança, contrato ou atomicidade dos commits.' + memoria +
      '\nSomente leitura. ' + SAIDA_EM_ARQUIVO + '\n' + GIT_PROIBIDO, guiasDe(m)),
      { label: `revisão: ${m.titulo}`, phase: 'Scrutiny', agentType: revisorPara(arquivos.map(normalizar)), schema: VALIDACAO },
    )),
    () => comRetentativa(`testes: ${m.titulo}`, () => trabalhar(montar('scrutiny',
      `Rode, no HEAD atual, os testes focados que cobrem os commits ${intervalo} do milestone "${m.titulo}"${semDeFora()} ` +
      `e confira o critério: ${m.criterio}.${reviseDeFora(m.titulo)} Não altere código. Reporte falhas com a saída relevante.` + memoria +
      '\n' + SAIDA_EM_ARQUIVO + '\n' + GIT_PROIBIDO, guiasDe(m)),
      { label: `testes: ${m.titulo}`, phase: 'Scrutiny', schema: VALIDACAO },
    )),
  ])
  if (!revisao || !testes) return { erro: 'um validador não respondeu' }
  const problemas = [...revisao.problemas, ...testes.problemas]
  const aprovado = revisao.aprovado && testes.aprovado
  if (!aprovado && problemas.length === 0) return { erro: 'validação reprovou sem apontar problemas' }
  return { aprovado, problemas }
}

const CONTRATO = {
  type: 'object',
  properties: {
    aprendizados: APRENDIZADOS,
    premissas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          premissa: { type: 'string' }, evidencia: { type: 'string' }, confere: { type: 'boolean' }, pergunta: { type: 'string' },
        },
        required: ['premissa', 'confere'],
      },
    },
  },
  required: ['premissas'],
}
const ACHADOS = {
  type: 'object',
  properties: {
    aprendizados: APRENDIZADOS,
    achados: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          arquivo: { type: 'string' }, problema: { type: 'string' }, repete: { type: 'boolean' },
          // Número do item da lista "Já corrigidos" que este achado repete.
          repeteItem: { type: 'integer' },
        },
        required: ['problema'],
      },
    },
  },
  required: ['achados'],
}
const VEREDITO = {
  type: 'object',
  properties: { aprendizados: APRENDIZADOS, confirmado: { type: 'boolean' }, motivo: { type: 'string' } },
  required: ['confirmado', 'motivo'],
}
const AREAS_CACA = { type: 'object', properties: { areas: { type: 'array', items: { type: 'string' } } }, required: ['areas'] }

// Antes de implementar: as premissas das features sobre o que o milestone não controla, conferidas no código do dono.
// Premissa falsa para a missão com todas as perguntas juntas.
async function provarContrato(m, aFazer) {
  const r = await comRetentativa(`contrato: ${m.titulo}`, () => trabalhar(montar('prova-de-contrato',
    `Milestone "${m.titulo}" (critério: ${m.criterio}). Features a implementar:\n` +
    aFazer.map(f => `- ${f.titulo}: ${f.spec}`).join('\n') + '\n\n' +
    'Liste as premissas que essas features fazem sobre outros serviços, módulos ou libs (rotas, campos, ids, ' +
    'comportamento) e confira cada uma no código do dono. Devolva cada premissa com a evidência (arquivo e linha), ' +
    'confere=true ou false e, se ela não confere ou é ambígua, a pergunta objetiva para o usuário. Sem premissa ' +
    'externa, devolva a lista vazia. Não escreva arquivos nem rode build: só leitura.\n' + GIT_PROIBIDO, guiasDe(m)),
    { label: `contrato: ${m.titulo}`, phase: 'Contrato', agentType: comoAgente(CONFIG.leitor), schema: CONTRATO },
  ))
  if (!r) return { motivo: 'o agente da prova de contrato não respondeu' }
  const falsas = r.premissas.filter(p => !p.confere)
  if (!falsas.length) return null
  return {
    motivo: `prova de contrato: ${falsas.length} premissa(s) do milestone não conferem no código do dono; responda as ` +
      'perguntas, ajuste o plano e retome (nada deste milestone foi implementado)',
    perguntas: falsas.map(p => p.pergunta || `confirmar: ${p.premissa}`),
    premissas: falsas,
  }
}

const TELAS = { type: 'object', properties: { ui: { type: 'string' } }, required: ['ui'] }
const DESIGN = {
  type: 'object',
  properties: { aprendizados: APRENDIZADOS, links: { type: 'array', items: { type: 'string' } }, texto: { type: 'string' } },
  required: ['texto'],
}
// UI/UX antes de implementar: só em milestone com tela (m.ui, ou detectado por agente barato pelas features). O desenho
// nunca espera aprovação: se o agente cair, a missão segue sem ele e registra no log.
async function desenharUi(m, aFazer) {
  if (designs[m.titulo]) return
  let ui = m.ui
  if (!ui) {
    const r = await comRetentativa(`telas: ${m.titulo}`, () => agent(
      `Features do milestone "${m.titulo}":\n${aFazer.map(f => `- ${f.titulo}: ${f.spec}`).join('\n')}\n` +
      'Se alguma cria ou muda tela, diálogo, formulário ou fluxo que um usuário percorre, descreva em ui as telas e ' +
      'fluxos, numa linha cada; senão devolva ui vazio. Não rode nada.',
      { label: `telas: ${m.titulo}`, phase: 'UI/UX', schema: TELAS, model: CONFIG.modeloConferencia, effort: 'low' },
    ))
    // Agente que caiu não decide nada: sem registro, a retomada tenta de novo.
    if (!r) {
      log(`${m.titulo}: o agente que detecta telas não respondeu; a missão segue sem UI/UX para este milestone`)
      return
    }
    ui = r.ui?.trim()
  }
  if (!ui) {
    designs[m.titulo] = { semTela: true }
    return
  }
  const r = await comRetentativa(`design: ${m.titulo}`, () => trabalhar(montar('ui-ux',
    `Desenhe as telas e fluxos do milestone "${m.titulo}" (critério: ${m.criterio}): ${ui}\nFeatures:\n` +
    aFazer.map(f => `- ${f.titulo}: ${f.spec}`).join('\n') + '\n' +
    'Se a skill /design, a skill impeccable ou a ferramenta Artifact de design estiver disponível, use-a para produzir o ' +
    'desenho e devolva os links em links. Em todo caso, devolva em texto, por tela: objetivo, elementos, componentes do ' +
    'design system do projeto, estados (carregando, vazio, erro, sucesso) e o fluxo de entrada e saída. Aplique o ' +
    'checklist de UX. Não espere aprovação de ninguém: decida e siga. Não altere código do produto.\n' + GIT_PROIBIDO, guiasDe(m)),
    { label: `design: ${m.titulo}`, phase: 'UI/UX', schema: DESIGN },
  ))
  if (!r) {
    log(`${m.titulo}: o agente de UI/UX não respondeu; a missão segue sem desenho para este milestone`)
    return
  }
  designs[m.titulo] = { ui, links: r.links ?? [], texto: r.texto, desvios: [] }
}

// Áreas de caça-bug quando o plano não traz m.caca: um agente barato as deriva dos arquivos tocados.
async function areasDeCaca(m, arquivos) {
  const r = await comRetentativa(`áreas de caça: ${m.titulo}`, () => agent(
    `Arquivos tocados pelo milestone "${m.titulo}": ${arquivos.join(', ') || 'nenhum'}. Agrupe-os em 1 a 4 áreas de ` +
    'risco para caçar bugs (ex.: autorização, persistência, contrato HTTP, tela). Devolva só os nomes das áreas, ' +
    'cada um com os caminhos que cobre entre parênteses. Não rode nada.',
    { label: `áreas de caça: ${m.titulo}`, phase: 'Caça bug', schema: AREAS_CACA, model: CONFIG.modeloConferencia, effort: 'low' },
  ))
  const areas = (r?.areas ?? []).filter(a => typeof a === 'string' && a.trim()).slice(0, 4)
  return areas.length ? areas : ['o diff inteiro']
}

const textoDoAchado = a => `${a.arquivo ?? ''} ${a.problema}`.trim()
// Um caçador por área sobre o diff; cada achado passa por 2 verificadores que tentam refutá-lo, e só fica o que os dois
// confirmam. Devolve { confirmados } ou { erro }.
async function cacar(rotulo, areas, intervalo, foco, corrigidos, guias) {
  const jaCorrigidos = corrigidos.length
    ? '\nJá corrigidos nesta missão (achou um deles de novo? marque repete=true e, em repeteItem, o número dele):\n' +
      corrigidos.map((b, i) => `${i + 1}. ${b}`).join('\n')
    : ''
  const porArea = await parallel(areas.map(area => () => comRetentativa(`caça: ${area} (${rotulo})`, () => trabalhar(montar('caca-bug',
    `Cace bugs reais no diff \`git diff ${intervalo}\`, na área: ${area}. ${foco}${jaCorrigidos}\n` +
    'Devolva cada achado com o arquivo e o problema demonstrável (passo a passo ou teste que quebra). Sem achado, ' +
    `lista vazia. Não altere código. ${SAIDA_EM_ARQUIVO}\n${GIT_PROIBIDO}`, guias),
    { label: `caça: ${area} (${rotulo})`, phase: 'Caça bug', schema: ACHADOS },
  ))))
  if (porArea.some(r => !r)) return { erro: `um caçador de bugs (${rotulo}) não respondeu` }
  // repete só vale apontando um item que existe na lista de corrigidos; senão o achado é bug novo e vai para correção.
  const achados = porArea.flatMap(r => r.achados).map(a => {
    if (!a.repete) return a
    const valido = Number.isInteger(a.repeteItem) && a.repeteItem >= 1 && a.repeteItem <= corrigidos.length
    if (valido) return { ...a, repete: true, repetido: corrigidos[a.repeteItem - 1] }
    log(`caça (${rotulo}): achado marcado como repetido sem item válido da lista de corrigidos; tratado como bug novo: ${textoDoAchado(a)}`)
    return { ...a, repete: false }
  })
  const vereditos = await parallel(achados.map((a, i) => () => parallel([1, 2].map(n => () =>
    comRetentativa(`verificação ${n}: achado ${i + 1} (${rotulo})`, () => trabalhar(montar('caca-bug',
      `Tente refutar este possível bug em \`git diff ${intervalo}\`: ${textoDoAchado(a)}\n` +
      'Confirme (confirmado=true) só se reproduzir ou se o código não deixar dúvida; na dúvida, confirmado=false. ' +
      `Explique em motivo. Não altere código. ${SAIDA_EM_ARQUIVO}\n${GIT_PROIBIDO}`, guias),
      { label: `verificação ${n}: achado ${i + 1} (${rotulo})`, phase: 'Caça bug', schema: VEREDITO },
    ))))))
  const confirmados = achados.filter((_, i) => vereditos[i]?.every(v => v?.confirmado === true))
  if (achados.length) log(`caça (${rotulo}): ${achados.length} achado(s), ${confirmados.length} confirmado(s) pelos dois verificadores`)
  return { confirmados }
}

const ACEITE = {
  type: 'object',
  properties: {
    aprendizados: APRENDIZADOS,
    criterios: {
      type: 'array',
      items: {
        type: 'object',
        properties: { criterio: { type: 'string' }, evidencia: { type: 'string' }, atendido: { type: 'boolean' } },
        required: ['criterio', 'atendido'],
      },
    },
    medicao: MEDICAO,
  },
  required: ['criterios'],
}
// Liga cada critério de aceite (args.aceite, a seção de aceite da SPEC ou os critérios dos milestones) a uma evidência.
async function conferirAceite() {
  const fonte = Array.isArray(args.aceite) && args.aceite.length
    ? `Critérios de aceite:\n- ${args.aceite.join('\n- ')}`
    : SPEC
      ? `${SPEC_NO_PROMPT()}\n\nUse os critérios de aceite da SPEC (a seção de aceite; se ela não tiver, os critérios dos milestones abaixo).\n` +
        milestones.map(m => `- ${m.titulo}: ${m.criterio}`).join('\n')
      : `Critérios de aceite (os dos milestones):\n${milestones.map(m => `- ${m.titulo}: ${m.criterio}`).join('\n')}`
  const r = await comRetentativa('aceite', () => trabalhar(montar('aceite',
    `${fonte}\n\nPara cada critério, aponte a evidência no HEAD atual: teste que passou (nome e comando) ou commit que ` +
    `o implementa (\`git log --oneline ${INICIO_MISSAO}..HEAD\`). atendido=true só com evidência concreta; sem ela, ` +
    `atendido=false e, em evidencia, o que falta para provar. Não altere código. ${SAIDA_EM_ARQUIVO}\n` +
    (MODO === 'enxugar' ? `${MEDIR} Meça do mesmo jeito que no início: ${JSON.stringify(medicaoAntes ?? {})}.\n` : '') +
    GIT_PROIBIDO, contexto.areas),
    { label: 'aceite', phase: 'Aceite', schema: ACEITE },
  ))
  if (!r) return { erro: 'o agente de aceite não respondeu' }
  if (!r.criterios.length) return { erro: 'o aceite não listou nenhum critério' }
  return { criterios: r.criterios, faltou: r.criterios.filter(c => !c.atendido), medicao: r.medicao ?? null }
}

// Jornada do milestone como usuário, na stack local.
async function testarComoUsuario(m, anteriores) {
  const memoria = anteriores.length
    ? `\nNa rodada anterior falharam: ${anteriores.map(p => p.problema).join(' | ')}. Confirme se foram resolvidos.`
    : ''
  const r = await comRetentativa(`user testing: ${m.titulo}`, () => trabalhar(montar('user-testing',
    `Percorra como usuário a jornada do milestone "${m.titulo}": ${m.userTesting}\n` +
    'Use só a stack local: pode subir os serviços locais com os comandos do projeto e usar navegador; nunca aponte ' +
    'para produção nem use credencial real. Não altere código. Ao terminar, derrube o que subiu e deixe a árvore como ' +
    'estava. Aprove só se a jornada inteira funcionar; cada falha vira um problema com o passo e a evidência. Se não ' +
    `der para subir a stack (ambiente), marque ambiente=true.` +
    (blocoDesign(m.titulo) ? `${blocoDesign(m.titulo)}\nConfira as telas prontas contra o desenho e o checklist de UX: cada desvio vira problema, com ux=true.` : '') +
    `${memoria}\n${SAIDA_EM_ARQUIVO}\n${GIT_PROIBIDO}`, guiasDe(m)),
    { label: `user testing: ${m.titulo}`, phase: 'User testing', schema: VALIDACAO },
  ))
  if (!r) return { erro: 'o agente de user testing não respondeu' }
  if (!r.aprovado && r.problemas.length === 0) return { erro: 'user testing reprovou sem apontar problemas' }
  const deAmbiente = r.problemas.filter(p => p.ambiente)
  if (!r.aprovado && deAmbiente.length) {
    return { erro: `o user testing não roda por causa do ambiente: ${deAmbiente.map(p => p.problema).join(' | ')}. Ajuste o ambiente e retome` }
  }
  const d = designs[m.titulo]
  // Só os desvios de UX da última rodada: o que as correções já resolveram não fica para o usuário revisar.
  if (d && !d.semTela) d.desvios = r.problemas.filter(p => p.ux === true).map(textoDoAchado)
  return { aprovado: r.aprovado, problemas: r.problemas }
}

// Correção e validação podem tocar qualquer parte do milestone: recebem todas as áreas dele. Na suíte final a falha
// pode estar em qualquer parte da missão: todas as áreas.
function guiasDe(m) {
  if (m.suite) return contexto.areas
  return [...new Set(m.features.filter(f => guiaPorFeature.has(f.titulo)).map(f => guiaPorFeature.get(f.titulo)))]
}

// `retomar` vai direto para args.retomar de uma nova execução: recomeça neste milestone, sem refazer o que já foi commitado.
// head e commits são só os que esta missão declarou; commit órfão de worker que caiu fica de fora de propósito.
function parar(m, base, feitas, commits, extra, jaConcluidas = []) {
  const concluidas = [...jaConcluidas, ...feitas.map(x => x.feature)]
  return {
    parouEm: m.titulo, ...extra, deForaTocando: [...deForaTocando], sujeiraCommitada: [...sujeiraCommitada], plano: { milestones }, designs: listaDesigns(), contexto, aprendizados: contexto.aprendizados,
    sugestaoAprendizados: sugestaoAprendizados(),
    retomar: { aPartirDe: m.titulo, branch: preparo.branch, inicioMissao: INICIO_MISSAO, base, head, commits: [...commits], concluidas, plano: { milestones }, contexto, deFora: [...deForaAceitos], deForaTocando: [...deForaTocando], bugsCorrigidos: [...bugsCorrigidos], cacaFinalFeita, modo: MODO, medicaoAntes, antesParcial, designs: { ...designs }, sujeiraInicial: [...sujeiraInicial], sujeiraCommitada: [...sujeiraCommitada], arquivosPendentes: extra.arquivosPendentes ?? [] },
    relatorio: [...relatorio, { milestone: m.titulo, commits: `${base}..${head}`, features: feitas }],
  }
}

for (const [i, m] of pendentes.entries()) {
  const retomando = i === 0 && retomar
  const base = retomando ? retomar.base : head
  const jaConcluidas = retomando ? retomar.concluidas ?? [] : []
  const feitas = []
  const commits = retomando ? [...retomar.commits] : []
  arquivosDoMilestone = new Set()
  if (retomando) {
    // Só retoma se o repositório está exatamente como a execução anterior deixou: nada de commit alheio no intervalo.
    // Lê a missão inteira (INICIO_MISSAO..HEAD) para também recuperar os arquivos que ela já commitou, no modo compacto
    // do script: em missão grande, arquivos por commit fariam uma saída que o modelo barato poderia cortar.
    const c = await lerGit(INICIO_MISSAO, 'Preparar', 'conferência', [' --resumo', base, ...deForaAceitos].join(' '))
    const esperado = retomar.commits
    const desde = !c ? -1 : mesmoSha(base, INICIO_MISSAO) ? 0 : c.commits.findIndex(s => mesmoSha(s, base)) + 1
    const doMilestone = c && (desde > 0 || mesmoSha(base, INICIO_MISSAO)) ? c.commits.slice(desde) : null
    // Commits depois do HEAD da parada são de fora: aceitos, como em qualquer ponto da missão.
    const extras = doMilestone && doMilestone.length > esperado.length ? doMilestone.slice(esperado.length) : []
    const intacto = c && doMilestone && c.branch === preparo.branch && (!retomar.branch || c.branch === retomar.branch) &&
      mesmoSha(c.head, head) && (extras.length ? mesmoSha(doMilestone[esperado.length - 1] ?? base, retomar.head) : mesmoSha(c.head, retomar.head)) &&
      doMilestone.length >= esperado.length && esperado.every((s, j) => mesmoSha(doMilestone[j], s)) &&
      (esperado.length > 0 || extras.length > 0 || mesmoSha(base, head))
    if (!intacto) {
      // Devolve o `retomar` recebido, intacto, para o usuário ajustar e tentar de novo.
      return { ...parar(m, base, feitas, [], {
        motivo: c
          ? `repositório mudou desde a parada (branch ${c.branch}, esperada ${retomar.branch ?? preparo.branch}; HEAD ${c.head}, esperado ${retomar.head}; ${doMilestone?.length ?? 'base fora da missão, nenhum'} commits em ` +
            `${base}..HEAD, esperados ${esperado.length}). Desfaça as mudanças ou, se forem da missão, atualize ` +
            'retomar.head, retomar.commits e retomar.concluidas antes de retomar'
          : `não foi possível ler o repositório para retomar${causaGit()}`,
      }, jaConcluidas), retomar }
    }
    let cm = c
    if (extras.length) {
      // Os arquivos da missão saem de uma nova leitura, já sem os extras; eles entram como de fora e nos esperados.
      const cx = await lerGit(retomar.head, 'Preparar')
      cm = await lerGit(INICIO_MISSAO, 'Preparar', 'conferência', [' --resumo', base, ...deForaAceitos, ...extras].join(' '))
      if (!cx || !cm) return { ...parar(m, base, feitas, [], { motivo: `não foi possível ler o repositório para retomar${causaGit()}` }, jaConcluidas), retomar }
      aceitarCommitsDeFora(cx, extras, m.titulo)
      commits.push(...extras)
    }
    // Arquivos que a missão já commitou, sem os dos commits de fora aceitos: base para marcar commit de fora que os toca.
    for (const a of cm.arquivos.map(normalizar)) arquivosDaMissao.add(a)
    for (const a of cm.arquivosDoMilestone.map(normalizar)) arquivosDoMilestone.add(a)
    log(`Retomando "${m.titulo}" sobre ${base}: ${esperado.length} commits anteriores, ${jaConcluidas.length} itens ` +
      `concluídos, ${arquivosDaMissao.size} arquivos já tocados pela missão; orçamento de correções recomeça em ${MAX_RODADAS_CORRECAO} rodadas`)
  }
  const aFazer = m.features.filter(f => !jaConcluidas.includes(f.titulo))
  log(m.suite ? 'Suíte completa do projeto' : `Milestone: ${m.titulo} (${aFazer.length} de ${m.features.length} features a implementar)`)
  const pararAqui = extra => {
    if (extra.motivo) log(`Parando em "${m.titulo}": ${extra.motivo}`)
    return parar(m, base, feitas, commits, extra, jaConcluidas)
  }
  const features = aFazer.map(f => ({ ...f, milestone: m.titulo, guias: guiaPorFeature.has(f.titulo) ? [guiaPorFeature.get(f.titulo)] : [] }))
  const guiasDoMilestone = guiasDe(m)
  let conf = null
  // Rodadas de correção do milestone, contadas em sequência por scrutiny, caça bug e user testing.
  let rodada = 0

  // Uma rodada de correção: cada problema vira uma feature com revisão e commit próprios, e o git é conferido.
  async function rodadaDeCorrecao(problemas) {
    rodada++
    if (problemas.length > MAX_PROBLEMAS_POR_RODADA) {
      return { motivo: `${problemas.length} problemas numa rodada (limite ${MAX_PROBLEMAS_POR_RODADA}); revise o plano`, problemas }
    }
    log(`${m.titulo}: ${problemas.length} problemas → rodada de correção ${rodada}`)
    const todos = problemas.map(textoDoAchado)
    const correcoes = todos.map((p, i) => ({
      titulo: `correção ${rodada}.${i + 1} (${m.titulo})`,
      spec: `Corrija: ${p}\n${m.suite ? 'Falha da suíte completa ao fim da missão' : `Milestone "${m.titulo}", critério: ${m.criterio}, commits ${base}..${head}`}.${semDeFora()}\n` +
        `Outros problemas da mesma rodada (podem ser duplicados deste ou já corrigidos): ${todos.filter((_, j) => j !== i).join(' | ') || 'nenhum'}.\n` +
        (MODO === 'enxugar'
          ? 'Corrija a causa dentro do modelo alvo: não restaure código nem teste que saiu de propósito, e os testes do ' +
            'que continua no modelo alvo não se desativam, pulam nem enfraquecem; não mexa em limites de cobertura para passar.'
          : 'Corrija a causa: não desative, pule nem enfraqueça testes, e não mexa em limites de cobertura para passar.'),
      guias: guiasDoMilestone,
      milestone: m.titulo,
      etapa: 'corrigir',
    }))
    const fix = await implementar(correcoes, 'Corrigir')
    feitas.push(...fix.resultados)
    commits.push(...fix.commits)
    if (fix.falhou) return fix.falhou
    conf = await conferir(base, commits, m.titulo)
    return conf.ok ? null : { motivo: conf.motivo }
  }

  // Avalia e corrige em loop enquanto os problemas diminuem; o teto só evita loop infinito. depois: o que roda após
  // cada correção, antes de reavaliar. Devolve null quando aprova, ou o motivo da parada.
  async function ateFechar(avaliar, depois) {
    let v = await avaliar([])
    for (let n = 1; ; n++) {
      if (v.erro) return { motivo: v.erro }
      if (v.aprovado) return null
      if (n > MAX_RODADAS_CORRECAO) return { motivo: `não fechou após ${MAX_RODADAS_CORRECAO} rodadas`, problemas: v.problemas }
      const e = (await rodadaDeCorrecao(v.problemas)) ?? (depois ? await depois() : null)
      if (e) return e
      const anterior = v.problemas
      v = await avaliar(anterior)
      if (!v.erro && !v.aprovado && v.problemas.length >= anterior.length) {
        return { motivo: `sem progresso na rodada ${rodada}: ${anterior.length} problemas antes, ${v.problemas.length} depois`, problemas: v.problemas }
      }
    }
  }
  // Scrutiny validator (a antiga validação): testes, lint, typecheck e revisão contra o critério, com correções.
  const scrutiny = () => ateFechar(anteriores => validar(m, base, conf.arquivos, anteriores))

  if (!m.suite && aFazer.length) {
    const e = await provarContrato(m, aFazer)
    if (e) return pararAqui(e)
    await desenharUi(m, aFazer)
  }

  const impl = await implementar(features, 'Implementar')
  feitas.push(...impl.resultados)
  commits.push(...impl.commits)
  if (impl.falhou) return pararAqui(impl.falhou)

  conf = await conferir(base, commits, m.titulo)
  if (!conf.ok) return pararAqui({ motivo: conf.motivo })
  let e = null

  // Caça final, curta: uma rodada sobre o diff da missão inteira, focada na interação entre milestones. As correções
  // dela seguem para a suíte final logo abaixo. Feita, vai marcada no retomar e não se repete na retomada.
  if (m.suite && !cacaFinalFeita && milestones.length > 1) {
    const c = await cacar('final, rodada 1', ['interação entre milestones'], `${INICIO_MISSAO}..${head}`,
      `Foque na interação entre os milestones da missão (${milestones.map(x => x.titulo).join(', ')}): contratos entre ` +
      `eles, dados que um grava e outro lê, ordem de execução.${semDeFora()}${reviseDeFora()}`, bugsCorrigidos, contexto.areas)
    if (c.erro) return pararAqui({ motivo: c.erro })
    const repetidos = c.confirmados.filter(a => a.repete)
    if (repetidos.length) {
      return pararAqui({ motivo: 'a caça final confirmou de novo bug já corrigido nesta missão; decida à mão antes de retomar', problemas: repetidos })
    }
    if (c.confirmados.length) e = await rodadaDeCorrecao(c.confirmados)
    if (e) return pararAqui(e)
    // Só conta como corrigido depois de a correção fechar: parada no meio não pode virar falso "bug repetido".
    bugsCorrigidos.push(...c.confirmados.map(textoDoAchado))
    cacaFinalFeita = true
  }

  e = await scrutiny()
  if (e) return pararAqui(e)

  // Caça bug depois que o scrutiny passa: bug confirmado vira correção, volta ao scrutiny e a caça recomeça. Para na
  // rodada sem bug confirmado ou no teto; bug confirmado de novo depois de corrigido para a missão.
  if (!m.suite) {
    const areas = m.caca ?? await areasDeCaca(m, conf.arquivos)
    for (let r = 1; ; r++) {
      const c = await cacar(`${m.titulo}, rodada ${r}`, areas, `${base}..${head}`,
        `Milestone "${m.titulo}", critério: ${m.criterio}.${semDeFora()}${reviseDeFora(m.titulo)}`, bugsCorrigidos, guiasDoMilestone)
      if (c.erro) return pararAqui({ motivo: c.erro })
      if (!c.confirmados.length) break
      const repetidos = c.confirmados.filter(a => a.repete)
      if (repetidos.length) {
        return pararAqui({ motivo: 'a caça confirmou de novo bug já corrigido nesta missão; decida à mão antes de retomar', problemas: repetidos })
      }
      // Só conta como corrigido depois de a correção fechar: parada no meio não pode virar falso "bug repetido".
      e = await rodadaDeCorrecao(c.confirmados)
      if (!e) {
        bugsCorrigidos.push(...c.confirmados.map(textoDoAchado))
        e = await scrutiny()
      }
      if (e) return pararAqui(e)
      if (r >= MAX_RODADAS_CACA) {
        log(`${m.titulo}: teto de ${MAX_RODADAS_CACA} rodadas de caça bug; as correções da última rodada passaram no scrutiny`)
        break
      }
    }
  }

  // User testing, só com jornada no plano: falha vira correção, que passa pelo scrutiny antes de testar de novo.
  if (m.userTesting) {
    e = await ateFechar(anteriores => testarComoUsuario(m, anteriores), scrutiny)
    if (e) return pararAqui(e)
  }

  // Aceite, com a suíte verde: cada critério ligado a uma evidência. Critério sem evidência vira correção uma vez (que
  // passa pela suíte de novo); se continuar sem, a missão termina reportando o que faltou.
  if (m.suite) {
    let a = await conferirAceite()
    if (!a.erro && a.faltou.length) {
      e = (await rodadaDeCorrecao(a.faltou.map(c => ({ problema: `critério de aceite sem evidência: ${c.criterio}. ${c.evidencia ?? ''}`.trim() }))))
        ?? await scrutiny()
      if (e) return pararAqui(e)
      a = await conferirAceite()
    }
    if (a.erro) return pararAqui({ motivo: a.erro })
    if (a.faltou.length) {
      return pararAqui({ motivo: `critérios de aceite sem evidência mesmo depois de uma correção: ${a.faltou.map(c => c.criterio).join(' | ')}`, faltou: a.faltou, aceite: a.criterios })
    }
    aceite = a.criterios
    medicaoDepois = a.medicao
  }

  // Os validadores rodam depois da última conferência: confirma que não sujaram a árvore nem commitaram.
  conf = await conferir(base, commits, m.titulo)
  if (!conf.ok) return pararAqui({ motivo: `após validação: ${conf.motivo}` })

  relatorio.push({ milestone: m.titulo, aprovado: true, rodadasCorrecao: rodada, commits: `${base}..${head}`, features: feitas })
}

const enxugar = MODO === 'enxugar' ? { modo: MODO, medicao: { antes: medicaoAntes, depois: medicaoDepois, ...(antesParcial ? { antesParcial: true } : {}) } } : {}
return { concluido: true, branch: preparo.branch, base: INICIO_MISSAO, head, plano: { milestones }, aceite, deForaTocando, sujeiraCommitada, ...enxugar, designs: listaDesigns(), contexto, aprendizados: contexto.aprendizados, sugestaoAprendizados: sugestaoAprendizados(), relatorio }
