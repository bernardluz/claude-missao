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
//       maxRodadasCaca?, aceite?, retomar?, config?
// Etapas: [simplicidade e plano, só com spec] → pré-voo → contexto do plano → por milestone: prova de contrato,
// features (implementa → revisão independente → commit atômico conferido), scrutiny ⇄ correções, caça bug ⇄ correções,
// user testing ⇄ correções → caça final entre milestones → suíte completa ⇄ correções → aceite.
// O git é lido pelo script git-estado.mjs, nunca pela interpretação de um modelo. Commit de outra sessão que não
// impacta a missão é aceito; o que impacta para a missão ali.
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
  // Modelo do agente que decide se um commit de fora da missão a impacta.
  modeloCommitDeFora: 'sonnet',
}
// @config-inicio (substituído por instalar.mjs)
const CONFIG_PROJETO = {}
// @config-fim
// Técnica curta de cada etapa, embutida por instalar.mjs a partir de etapas/<etapa>.md e do complemento do projeto em
// .claude/missao/etapas/: o script do Workflow não lê arquivos. No núcleo cru fica vazio.
// @etapas-inicio (substituído por instalar.mjs)
const ETAPAS = {}
// @etapas-fim
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
  for (const k of ['formatoCommit', 'idioma', 'exemplosSkills', 'modeloConferencia', 'modeloCommitDeFora']) if (typeof CONFIG[k] !== 'string') erros.push(`${k} deve ser texto`)
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

// `*.stackdump` não rastreado na raiz é dump de crash do bash do Windows (msys): artefato descartável do ambiente,
// não mudança de ninguém. O agente de commit o apaga; até lá, as conferências o toleram em vez de parar a missão.
const DUMP_DO_BASH = '`*.stackdump` não rastreado na raiz do repositório é dump de crash do bash do Windows (msys), ' +
  'artefato descartável do ambiente'
const ehDump = caminho => /^[^/]+\.stackdump$/i.test(caminho)
function arvoreLimpa(c) {
  if (c.limpo) return true
  const linhas = (c.pendencias ?? []).map(l => l.trim()).filter(Boolean)
  const dumps = linhas.map(l => /^\?\? "?(.+?)"?$/.exec(l)?.[1]).filter(p => p && ehDump(p))
  if (linhas.length === 0 || dumps.length < linhas.length) return false
  log(`dump de crash do bash na raiz, tolerado como artefato do ambiente: ${dumps.join(', ')}`)
  return true
}
function pendenciasDe(c) {
  const linhas = (c.pendencias ?? []).map(l => l.trim()).filter(Boolean)
  if (linhas.length === 0) return ''
  return `: ${linhas.slice(0, 10).join(', ')}${linhas.length > 10 ? ` e mais ${linhas.length - 10}` : ''}`
}

const RESULTADO_FEATURE = {
  type: 'object',
  properties: {
    concluida: { type: 'boolean' },
    jaResolvido: { type: 'boolean' },
    arquivos: { type: 'array', items: { type: 'string' } },
    resumo: { type: 'string' },
    aprendizados: { type: 'array', items: { type: 'string' } },
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
    recusado: { type: 'boolean' },
    foraDaLista: { type: 'array', items: { type: 'string' } },
    descartados: { type: 'array', items: { type: 'string' } },
    motivo: { type: 'string' },
  },
  required: ['commitado'],
}

// Script instalado no projeto pelo instalar.mjs (fonte: git-estado.mjs no claude-missao).
const GIT_ESTADO = '.claude/missao/git-estado.mjs'
// O agente de conferência só devolve a saída literal do script de estado do git; quem a interpreta é o workflow.
const SAIDA = { type: 'object', properties: { saida: { type: 'string' } }, required: ['saida'] }

// Todo worker pode devolver fatos não óbvios que descobriu; eles se acumulam no contexto da missão.
const APRENDIZADOS = { type: 'array', items: { type: 'string' } }

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
        properties: { arquivo: { type: 'string' }, problema: { type: 'string' }, ambiente: { type: 'boolean' } },
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

const PRE_VOO = {
  type: 'object',
  properties: { aprendizados: APRENDIZADOS, ok: { type: 'boolean' }, faltando: { type: 'array', items: { type: 'string' } } },
  required: ['ok', 'faltando'],
}

// Plano: args.milestones (ou args.plano.milestones) direto; na retomada, o que voltou em retomar.plano. Só com
// args.spec, a missão verifica a simplicidade da SPEC e gera o plano antes de começar.
const SPEC = typeof args?.spec === 'string' && args.spec.trim() ? args.spec.trim() : null
const planoDado = args?.milestones ?? args?.plano?.milestones ?? args?.retomar?.plano?.milestones ?? null
const limitesOk = [MAX_RODADAS_CORRECAO, MAX_PROBLEMAS_POR_RODADA, MAX_RODADAS_REVISAO, MAX_FEATURES_POR_MILESTONE, MAX_RODADAS_CACA].every(n => Number.isInteger(n) && n >= 1) &&
  Number.isInteger(MAX_RETENTATIVAS_INFRA) && MAX_RETENTATIVAS_INFRA >= 0
const aceiteOk = args?.aceite === undefined || (Array.isArray(args.aceite) && args.aceite.every(x => typeof x === 'string'))
if (!args || !limitesOk || !aceiteOk || (!planoDado && !SPEC)) {
  throw new Error('args inválido: { milestones: [{ titulo, criterio, caca?, userTesting?, features: [{ titulo, spec }] }] } ou ' +
    '{ spec }, com maxRodadasCorrecao?, maxProblemasPorRodada?, maxRodadasRevisao?, maxFeaturesPorMilestone?, ' +
    'maxRetentativasInfra?, maxRodadasCaca?, aceite?: [critérios], retomar?; limites inteiros ≥ 1 e retentativas ≥ 0')
}

// A suíte completa roda uma vez ao fim, como uma etapa sem features: falha vira correção no mesmo loop.
const SUITE = { titulo: 'Suíte final', criterio: 'a suíte completa do projeto passa', features: [], suite: true }
const repetidosEm = lista => [...new Set(lista.filter((t, i) => lista.indexOf(t) !== i))]
// Por que o plano não serve, ou null. Vale para o plano passado e para o gerado a partir da SPEC.
function erroDoPlano(ms) {
  const textos = v => Array.isArray(v) && v.every(x => typeof x === 'string' && x.trim())
  const forma = Array.isArray(ms) && ms.length > 0 && ms.every(m => m && m.titulo && m.criterio &&
    Array.isArray(m.features) && m.features.length > 0 && m.features.every(f => f && f.titulo && f.spec) &&
    (m.caca === undefined || textos(m.caca)) && (m.userTesting === undefined || typeof m.userTesting === 'string'))
  if (!forma) {
    return 'plano inválido: milestones: [{ titulo, criterio, caca?: [áreas], userTesting?: jornada, features: [{ titulo, spec }] }], sem listas vazias'
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
if (retomar?.contexto) {
  const lista = v => (Array.isArray(v) ? v : [])
  contexto.areas = lista(retomar.contexto.areas)
  contexto.aprendizados.push(...lista(retomar.contexto.aprendizados).filter(a => typeof a === 'string'))
}
function aprender(r) {
  for (const a of Array.isArray(r?.aprendizados) ? r.aprendizados : []) {
    const t = typeof a === 'string' ? a.trim() : ''
    if (t && !contexto.aprendizados.includes(t)) contexto.aprendizados.push(t)
  }
  return r
}
// Agente que trabalha, revisa ou valida: o que ele aprende entra no contexto dos próximos prompts.
const trabalhar = async (prompt, opt) => aprender(await agent(prompt, opt))
const APRENDER = 'Se descobrir um fato não óbvio do projeto que ajude as próximas etapas (ex.: "o serviço X devolve ' +
  '404 sem acesso", "rode os testes com forks=1"), devolva-o em aprendizados, numa frase cada.'

// Prompt de etapa = técnica da etapa (etapas/<etapa>.md, embutida pelo instalador) + trecho pertinente do contexto do
// plano + aprendizados + a tarefa.
function montar(etapa, tarefa, areas = []) {
  const partes = []
  if (ETAPAS[etapa]) partes.push(`Técnica da etapa ${etapa} (orientação; regras do repo prevalecem):\n${ETAPAS[etapa]}`)
  if (areas.length) partes.push('Contexto do plano (orientação; regras do repo prevalecem):\n' + areas.map(s => `### ${s.nome}\n${s.guia}`).join('\n\n'))
  if (contexto.aprendizados.length) partes.push(`Aprendizados desta missão:\n- ${contexto.aprendizados.join('\n- ')}`)
  const final = `${tarefa}\n${APRENDER}`
  return partes.length ? `${partes.join('\n\n')}\n\nSe algo acima contrariar as proibições da tarefa, as proibições vencem.\n\n${final}` : final
}
const SPEC_NO_PROMPT = () => `SPEC (texto, ou caminho de arquivo no repositório para ler inteiro):\n${SPEC}`

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
const preparo = await lerGit('HEAD', 'Preparar', 'preparo')
if (!preparo || !arvoreLimpa(preparo) || !preparo.branch) {
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
  if (!s) return { parouEm: 'simplicidade', motivo: 'o agente que verifica a simplicidade não respondeu', aprendizados: contexto.aprendizados }
  if (!s.ok || s.perguntas.length || s.cortes.length) {
    return {
      parouEm: 'simplicidade',
      motivo: 'a verificação de simplicidade trouxe perguntas ou cortes: decida, ajuste a SPEC e rode de novo (nenhum código foi escrito)',
      perguntas: s.perguntas, cortes: s.cortes, aprendizados: contexto.aprendizados,
    }
  }
  phase('Planejar')
  const p = await comRetentativa('planejar', () => trabalhar(montar('planejar',
    `${SPEC_NO_PROMPT()}\n\nA SPEC foi aprovada. Leia-a e o código que ela toca e gere o plano: milestones com titulo, ` +
    `criterio verificável, caca (áreas de caça-bug do milestone), userTesting (a jornada, só se houver uma que um ` +
    `usuário percorre; senão omita) e features com titulo único e spec. No máximo ${MAX_FEATURES_POR_MILESTONE} ` +
    `features por milestone; o título "${SUITE.titulo}" é reservado. Não escreva arquivos nem rode build: só leitura.\n` +
    GIT_PROIBIDO),
    { label: 'planejar', phase: 'Planejar', agentType: comoAgente(CONFIG.leitor), schema: PLANO },
  ))
  // Campo opcional vazio conta como ausente.
  const gerado = p?.milestones?.map(m => ({ ...m, caca: m.caca?.length ? m.caca : undefined, userTesting: m.userTesting?.trim() || undefined }))
  const erro = gerado ? erroDoPlano(gerado) : 'o agente de planejamento não respondeu'
  if (erro) return { parouEm: 'planejar', motivo: `plano gerado não serve: ${erro}`, plano: p ?? null, aprendizados: contexto.aprendizados }
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
// preparo, pré-voo, conferência da retomada e contexto (se não veio do retomar); por feature: worker, revisão, commit e conferência; por
// milestone: prova de contrato, 2 conferências, 2 validadores, caça (um caçador por área, mais o agente que deriva as
// áreas se o plano não as traz) e user testing se houver jornada; fim: caça final (com 2+ milestones, fora da
// retomada na suíte), 2 conferências, suíte e aceite
const porMilestone = m => 5 + (m.caca ? m.caca.length : 2) + (m.userTesting ? 1 : 0)
const estimativa = 2 + (retomar ? 1 : 0) + (retomar?.contexto ? 0 : 1) + 4 * totalFeatures +
  pendentes.filter(m => !m.suite).reduce((n, m) => n + porMilestone(m), 0) +
  (milestones.length > 1 && inicio < milestones.length ? 1 : 0) + 4
log(`Estimativa mínima: ${estimativa} agentes a partir daqui (sem contar correções e retentativas)`)

const relatorio = []
// Commits de fora aceitos (não impactam a missão), levados no retomar: não contam como da missão.
const deForaAceitos = Array.isArray(args.retomar?.deFora) ? args.retomar.deFora.filter(s => typeof s === 'string') : []
// Bugs que a caça confirmou e a missão corrigiu: confirmado de novo, para a missão.
const bugsCorrigidos = []
// Critérios de aceite com a evidência de cada um, preenchidos ao fim.
let aceite = null

// Antes de qualquer commit: o ambiente roda o que a suíte e os testes vão precisar? Roda também na retomada.
phase('Pré-voo')
const preVoo = await comRetentativa('pré-voo', () => trabalhar(montar('pre-voo',
  'Confira se o ambiente roda o que esta missão vai precisar para os testes focados e a suíte final' +
  (CONFIG.preVoo ? `: ${CONFIG.preVoo}` : ': descubra pelo plano abaixo e pelo projeto os runners de teste, build e serviços de apoio') +
  `.\nNão altere código nem arquivos versionados. ${SAIDA_EM_ARQUIVO}\n` +
  'Devolva ok=true só se tudo o que a missão vai usar funciona; senão, em faltando, cada item que falta, com como ' +
  `conferir e como resolver.\n${GIT_PROIBIDO}\n\n${planoTexto}`),
  { label: 'pré-voo', phase: 'Pré-voo', schema: PRE_VOO },
))
if (!preVoo || !preVoo.ok) {
  const motivo = preVoo
    ? `o ambiente não está pronto: ${preVoo.faltando.join(' | ') || 'sem detalhe'}. Ajuste o ambiente e rode de novo`
    : 'o agente de pré-voo não respondeu'
  // Parada antes de qualquer commit: devolve o retomar recebido ou um que recomeça no primeiro milestone.
  const r = retomar ?? parar(pendentes[0], head, [], [], {}).retomar
  return { parouEm: 'pré-voo', motivo, faltando: preVoo?.faltando ?? [], plano: { milestones }, contexto, aprendizados: contexto.aprendizados, retomar: r }
}

// Hidratação, como a Factory: o contexto do plano (guias por área, montados a partir do código atual) é gerado UMA vez
// por missão e volta no `retomar`; a retomada o reaproveita, junto com os aprendizados, em vez de regenerá-lo.
phase('Contexto')
if (retomar?.contexto) {
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
const unificar = a => a.trim().replace(/\\/g, '/').replace(/^\/([a-z])\//i, '$1:/')
function normalizar(a) {
  const c = unificar(a).replace(/^\.\//, '')
  const raiz = unificar(preparo.raiz).replace(/\/+$/, '')
  return c.toLowerCase().startsWith(raiz.toLowerCase() + '/') ? c.slice(raiz.length + 1) : c
}
// Pasta nova aparece no `git status` como `novo/`: declarada assim, cobre os arquivos de dentro.
const naLista = (arquivos, a) => arquivos.has(a) || [...arquivos].some(p => p.endsWith('/') && a.startsWith(p))

function promptTrabalho(f, extra) {
  return montar(f.etapa ?? 'implementar',
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
// Devolve { commit, parar? }, { apontamento } ou { erro, semDiff? }. parar: motivo para parar depois de conferir o
// commit. semDiff: o diff da feature não ficou pendente, então a parada não manda descartá-lo.
async function commitar(f, arquivos, fase, antes) {
  const chamar = aviso => agent(
    `Faça UM commit atômico da feature "${f.titulo}", já revisada e aprovada. Arquivos da feature: ${[...arquivos].join(', ')}.\n` +
    '- confira `git status`; se houver mudança em caminho fora dessa lista, não commite: devolva commitado=false e ' +
    'liste esses caminhos em foraDaLista;\n' +
    `- arquivo ${DUMP_DO_BASH}: apague-o, informe o caminho em descartados e não o conte como mudança fora da lista. ` +
    'No repositório, não apague mais nada;\n' +
    '- inclua exatamente os caminhos da lista (`git add -- <paths>`, nunca `git add -A`); caminho da lista que não ' +
    'aparece no `git status` (revertido no ajuste) é ignorado;\n' +
    `- mensagem ${CONFIG.formatoCommit} em ${CONFIG.idioma} descrevendo a feature, gravada em arquivo temporário FORA do repositório ` +
    '(ex.: saída de `mktemp`), usada com `git commit -F <arquivo> -- <paths>` e apagada depois;\n' +
    '- rode o commit com a saída em arquivo, nunca por pipe, porque os hooks rodam gates: ' +
    '`log=$(mktemp); git commit -F <arquivo> -- <paths> > "$log" 2>&1; echo "saida=$?"; tail -40 "$log"`;\n' +
    '- você NÃO altera código em hipótese alguma: se um gate do commit falhar, não corrija; devolva commitado=false, ' +
    'gateFalhou=true e a saída relevante em motivo;\n' +
    '- se o harness ou o classificador de permissões recusar uma ferramenta ou um comando, não tente de outro jeito ' +
    '(outro comando, outra ferramenta, outro caminho): pare e devolva recusado=true, o texto da recusa em motivo e ' +
    'commitado=false, ou commitado=true com o SHA se o commit já tinha sido feito. Recusa exige decisão humana;\n' +
    '- devolva o SHA completo (`git rev-parse HEAD`).' + aviso + '\n' + SAIDA_EM_ARQUIVO + '\n' + GIT_PROIBIDO,
    { label: `commit: ${f.titulo}`, phase: fase, schema: RESULTADO_COMMIT, effort: 'low' },
  )
  async function tentar(aviso = '') {
    let r = await chamar(aviso)
    for (let t = 1; !r && t <= MAX_RETENTATIVAS_INFRA; t++) {
      const c = await lerGit(antes, fase)
      if (!c) return { erro: 'agente de commit caiu e não foi possível ler o repositório' }
      if (c.commits.length > 0) {
        // A lista só cresce e pode ter caminho revertido; o commit adotado precisa estar contido nela.
        const mesmos = c.arquivos.length > 0 && c.arquivos.every(a => naLista(arquivos, normalizar(a)))
        if (c.branch === preparo.branch && arvoreLimpa(c) && c.commits.length === 1 && mesmos) return { commitado: true, commit: c.commits[0] }
        return { erro: `agente de commit caiu deixando ${c.commits.length} commit(s) que não correspondem à feature ` +
          `revisada (${c.commits.join(', ')}); pode haver commit de fora da missão` }
      }
      log(`commit: ${f.titulo}: agente não retornou (queda ou pulo manual), tentativa ${t + 1} de ${MAX_RETENTATIVAS_INFRA + 1}`)
      r = await chamar(aviso)
    }
    const apagados = (r?.descartados ?? []).map(normalizar).filter(ehDump)
    if (apagados.length) log(`${f.titulo}: agente de commit apagou dump de crash do bash: ${apagados.join(', ')}`)
    return r ?? { erro: `agente de commit não retornou após ${MAX_RETENTATIVAS_INFRA + 1} tentativas` }
  }
  // Apagado no repositório além do dump; caminho que segue absoluto está fora dele (ex.: o arquivo da mensagem).
  const indevidosDe = r => (r.descartados ?? []).map(normalizar).filter(a => !/^([a-z]:)?\//i.test(a) && !ehDump(a))
  const soDump = r => !r.commitado && !r.recusado && !r.gateFalhou && indevidosDe(r).length === 0 &&
    r.foraDaLista?.length > 0 && r.foraDaLista.every(a => ehDump(normalizar(a)))
  let r = await tentar()
  if (soDump(r)) {
    // O dump não é da feature: em vez de virar apontamento, o commit é repetido uma vez com o aviso.
    log(`${f.titulo}: agente de commit listou dump de crash do bash como fora da lista (${r.foraDaLista.join(', ')}); repetindo o commit`)
    r = await tentar(`\nNa tentativa anterior você listou ${r.foraDaLista.join(', ')} como fora da lista: é dump de ` +
      'crash do bash, apague-o e siga com o commit.')
  }
  if (r.erro) return { erro: r.erro }
  const feito = r.commitado && r.commit ? r.commit : null
  // Recusa contornada ou arquivo apagado além do dump não se resolvem com ajuste: a decisão é humana.
  const indevidos = indevidosDe(r)
  const parar = r.recusado
    ? `o harness recusou um comando do agente de commit, e a missão não contorna recusa: ${r.motivo ?? 'sem texto'}`
    : indevidos.length ? `o agente de commit apagou o que não é dump de crash do bash: ${indevidos.join(', ')}` : null
  if (parar) return feito ? { commit: feito, parar } : { erro: `${parar}. Decida à mão, conferindo \`git status\` e \`git log\`` }
  if (feito) return { commit: feito }
  if (r.gateFalhou) return { apontamento: `gate do commit falhou: ${r.motivo ?? 'sem saída'}` }
  const fora = (r.foraDaLista ?? []).filter(a => !ehDump(normalizar(a)))
  if (fora.length) {
    return { apontamento: `mudanças fora da lista da feature: ${fora.join(', ')}. Se forem desta feature, ` +
      'declare-as em arquivos; se não, desfaça só elas' }
  }
  if (soDump(r)) return { erro: `o agente de commit não apagou o dump de crash do bash (${r.foraDaLista.join(', ')}); apague-o à mão` }
  // Sem commit e sem causa conhecida: um commit de fora da missão (ex.: `git commit -a`) pode ter levado o diff.
  const c = await lerGit(antes, fase)
  if (c?.commits.length) {
    return { semDiff: arvoreLimpa(c), erro: `o agente de commit não commitou (${r.motivo ?? 'sem motivo'}), e ${antes}..HEAD tem ` +
      `commit de fora da missão: ${c.commits.join(', ')}, que pode ter levado o diff da feature. ${comoAceitar(c.head)}. ` +
      `Se aceitar e o diff da feature foi junto, inclua também "${f.titulo}" em retomar.concluidas` }
  }
  return { erro: r.motivo ?? 'commit não realizado' }
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

const DE_FORA = {
  type: 'object',
  properties: { impacta: { type: 'boolean' }, motivo: { type: 'string' } },
  required: ['impacta', 'motivo'],
}
// Commit de outra sessão ou automação não para a missão se não a impacta: tocar arquivo dela para na hora; o resto,
// um agente barato julga pelo que o commit muda. emCurso: arquivos da feature ainda não conferida.
async function julgarDeFora(c, deFora, fase, emCurso = []) {
  const doMilestone = [...new Set([...arquivosDoMilestone, ...emCurso])]
  const daMissao = new Set([...arquivosDaMissao, ...doMilestone])
  const arquivosDe = s => (c.arquivosPorCommit?.[s] ?? []).map(normalizar)
  const tocados = deFora.flatMap(arquivosDe).filter(a => naLista(daMissao, a))
  if (tocados.length) return { impacta: true, motivo: `O commit de fora toca arquivo da missão: ${[...new Set(tocados)].join(', ')}` }
  const r = await comRetentativa('commit de fora', () => agent(
    'Apareceram na branch commits que não são desta missão:\n' +
    deFora.map(s => `- ${s}: ${arquivosDe(s).join(', ') || 'arquivos não informados'}`).join('\n') +
    '\nVeja mensagem, arquivos e diffstat de cada um com `git show --stat <sha>`.\n' +
    `Arquivos da missão: ${[...arquivosDaMissao].join(', ') || 'nenhum ainda'}.\n` +
    `Arquivos do milestone atual: ${doMilestone.join(', ') || 'nenhum ainda'}.\n` +
    'Devolva impacta=true se algum desses commits toca arquivo da missão ou algo de que ela depende (build, ' +
    'dependências, migrations do mesmo módulo, contrato que ela usa); senão impacta=false. Explique em motivo, numa ' +
    'frase. Somente leitura.\n' + GIT_PROIBIDO,
    { label: 'commit de fora', phase: fase, schema: DE_FORA, model: CONFIG.modeloCommitDeFora, effort: 'low' },
  ))
  if (!r) return { impacta: true, motivo: 'O agente que julga commit de fora não respondeu' }
  if (!r.impacta) {
    deForaAceitos.push(...deFora)
    log(`commit de fora aceito, não impacta a missão: ${deFora.join(', ')}. ${r.motivo}`)
  }
  return r
}

// A missão não decide pelo usuário se fica um commit que ela não revisou: diz como aceitá-lo na retomada.
const aceitar = headReal => 'ponha em retomar.commits a saída de `git rev-list --reverse <retomar.base>..HEAD` e em ' +
  `retomar.head o HEAD real, ${headReal}`
const comoAceitar = headReal => `Para aceitá-lo, ${aceitar(headReal)}; para recusá-lo, tire-o do histórico e ajuste retomar ao git resultante`

// Logo depois do commit de cada feature: `antes..HEAD` tem de ser exatamente o commit declarado, com arquivos da lista
// revisada e árvore limpa. naoAdotar: o commit não entra no `retomar`, porque não está no git ou tem arquivo não
// revisado; sem ajuste, a retomada recusa.
async function conferirCommit(f, commit, antes, arquivos, fase) {
  const c = await lerGit(antes, fase)
  if (!c) return { motivo: `a conferência logo depois do commit de "${f.titulo}" não retornou; o commit declarado, ${commit}, entrou em retomar sem ser conferido` }
  if (c.branch !== preparo.branch) return { motivo: `branch mudou para "${c.branch}" logo depois do commit de "${f.titulo}"` }
  if (!c.commits.some(s => mesmoSha(s, commit))) {
    return { naoAdotar: true, motivo: `o agente de commit declarou ${commit}, mas ${antes}..HEAD tem ` +
      `${c.commits.join(', ') || 'nenhum commit'}; confira o git e ajuste retomar à mão` }
  }
  const deFora = commitsDeFora(c, [commit])
  if (deFora.length) {
    const d = await julgarDeFora(c, deFora, fase, [...arquivos])
    if (d.impacta) {
      return { motivo: `commit de fora da missão logo depois da feature "${f.titulo}": ${deFora.join(', ')}. Em ${antes}..HEAD ` +
        `só devia estar ${commit}, o commit da feature, que já entrou em retomar. ${comoAceitar(c.head)}. ${d.motivo}` }
    }
  } else if (!mesmoSha(c.head, commit)) return { motivo: `HEAD real ${c.head} difere do commit declarado ${commit}` }
  // Com commit de fora aceito no intervalo, só os arquivos do commit da feature contam.
  const doCommit = deFora.length ? c.arquivosPorCommit?.[c.commits.find(s => mesmoSha(s, commit))] ?? c.arquivos : c.arquivos
  const alheios = doCommit.map(normalizar).filter(a => !naLista(arquivos, a))
  if (alheios.length) {
    return { naoAdotar: true, motivo: `o commit de "${f.titulo}", ${commit}, tem arquivos fora da lista revisada: ` +
      `${alheios.join(', ')}. Ele ficou fora do retomar. Para aceitá-lo, ${aceitar(c.head)}, e inclua "${f.titulo}" em ` +
      'retomar.concluidas; para recusá-lo, tire-o do histórico e retome sem mudar o retomar, e a feature se repete' }
  }
  if (!arvoreLimpa(c)) return { motivo: `árvore com mudanças não commitadas depois do commit de "${f.titulo}"${pendenciasDe(c)}` }
  return { novos: c.commits, head: c.head }
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
    const r = await comRetentativa(f.titulo, () => trabalhar(promptTrabalho(f, parcial
      ? '\nUma tentativa anterior caiu no meio: o diff não commitado atual é trabalho parcial desta feature. Continue a ' +
        'partir dele e declare em `arquivos` também os caminhos que ela já tinha alterado (veja `git status`).'
      : ''),
      { label: f.titulo, phase: fase, schema: RESULTADO_FEATURE },
    ), async () => {
      const c = await lerGit(antes, fase)
      if (!c) return { ok: false, semLeitura: true }
      if (c.branch !== preparo.branch || !mesmoSha(c.head, antes) || c.commits.length > 0) {
        return { ok: false, head: c.head, motivo: `branch ${c.branch}, HEAD ${c.head}, ${c.commits.length} commit(s) novo(s)` +
          (c.commits.length ? `: ${c.commits.join(', ')}` : '') }
      }
      if (!arvoreLimpa(c)) parcial = true
      return { ok: true }
    })
    if (r?.semRetentativa) {
      const e = r.semRetentativa
      return falhou(e.semLeitura
        ? 'agente caiu e não foi possível ler o repositório para decidir se era seguro repetir'
        : `agente caiu e o histórico mudou (${e.motivo}), por commit dele ou de fora da missão. Desfaça isso para ` +
          `repetir a feature. Se for commit de fora e quiser aceitá-lo, ${aceitar(e.head)}, descartando o diff parcial ` +
          'da feature, se houver')
    }
    if (!r) return falhou(`agente não retornou após ${MAX_RETENTATIVAS_INFRA + 1} tentativas.${sujo}`)
    if (!r.concluida) return falhou(r.resumo + sujo)
    // Dump do bash não é da feature, mesmo que o worker o declare.
    const arquivos = new Set((r.arquivos ?? []).map(normalizar).filter(a => !ehDump(a)))
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
    let pararDepois = null
    while (!commit) {
      const memoria = anteriores.length
        ? `\nNa rodada anterior foram apontados: ${anteriores.join(' | ')}. Confirme se foram resolvidos.`
        : ''
      const rev = await comRetentativa(`revisão: ${f.titulo}`, () => trabalhar(montar('revisar',
        `Revisão independente, antes do commit, da feature "${f.titulo}". Spec: ${f.spec}\n` +
        'Todo o diff ainda não commitado é desta feature: veja `git status`, `git diff HEAD` (inclui o que estiver em ' +
        `stage) e os arquivos novos. Arquivo ${DUMP_DO_BASH}: ignore-o. ` +
        'Aponte só problemas bloqueantes de correção, segurança, contrato ou testes faltantes.' +
        memoria + '\nSomente leitura. ' + SAIDA_EM_ARQUIVO + '\n' + GIT_PROIBIDO, f.guias ?? []),
        { label: `revisão: ${f.titulo}`, phase: fase, agentType: revisorPara([...arquivos]), schema: VALIDACAO },
      ))
      if (!rev) return falhou('revisor da feature não respondeu.' + sujo)
      let problemas
      if (rev.aprovado) {
        const c = await commitar(f, arquivos, fase, antes)
        if (c.commit) { commit = c.commit; pararDepois = c.parar; break }
        if (c.erro) return falhou(c.semDiff ? c.erro : c.erro + '.' + sujo)
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
      const ajuste = await comRetentativa(`${f.titulo} · ajuste ${rodada}`, () => trabalhar(promptTrabalho(f,
        `\nO diff atual, ainda não commitado, já implementa esta feature. Ajuste-o conforme os apontamentos:\n- ` +
        problemas.join('\n- ') +
        '\nSe um gate falhar por causa fora desta feature (ambiente, dívida de outro código), não mexa em arquivos ' +
        'alheios: devolva concluida=false explicando.'),
        { label: `${f.titulo} · ajuste ${rodada}`, phase: fase, schema: RESULTADO_FEATURE },
      ))
      if (!ajuste) return falhou(`agente de ajuste não retornou após ${MAX_RETENTATIVAS_INFRA + 1} tentativas.${sujo}`)
      if (!ajuste.concluida) return falhou(ajuste.resumo + sujo)
      for (const a of (ajuste.arquivos ?? []).map(normalizar)) if (!ehDump(a)) arquivos.add(a)
      anteriores = problemas
    }

    // Commit de outra sessão no meio da missão para aqui, antes da próxima feature, e não só no fim do milestone.
    const pos = await conferirCommit(f, commit, antes, arquivos, fase)
    if (!pos.naoAdotar) {
      // Conferido, o intervalo pode trazer também commits de fora aceitos, na ordem real.
      head = pos.head ?? commit
      commits.push(...(pos.novos ?? [commit]))
      for (const a of arquivos) { arquivosDaMissao.add(a); arquivosDoMilestone.add(a) }
      resultados.push({ feature: f.titulo, ...r, commit, rodadasRevisao: rodada })
    }
    if (pos.motivo) return falhou(pararDepois ? `${pararDepois}. ${pos.motivo}` : pos.motivo)
    if (pararDepois) return falhou(`${pararDepois}. O commit da feature, ${commit}, já entrou em retomar: decida à mão antes de retomar`)
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
    typeof c.limpo === 'boolean' && lista(c.pendencias) && lista(c.commits) && lista(c.arquivos)
  return valido ? c : null
}
function lerGit(base, fase, label = 'conferência') {
  return comRetentativa(label, async () => {
    const r = await agent(
      `Rode exatamente \`node ${GIT_ESTADO} ${base}\` na raiz do repositório e devolva em saida a saída padrão ` +
      'literal e completa, sem resumir, reordenar nem comentar. Não rode mais nada. Se o comando falhar, devolva o erro em saida.',
      { label, phase: fase, agentType: comoAgente(CONFIG.leitor), schema: SAIDA, model: CONFIG.modeloConferencia, effort: 'low' },
    )
    if (!r) return null
    const c = estadoDoGit(r.saida)
    if (!c) log(`${label}: saída de ${GIT_ESTADO} inválida (${String(r.saida).slice(0, 120)}); repetindo a leitura`)
    return c
  })
}

// Confere que o intervalo tem exatamente os commits declarados.
async function conferir(base, esperados, fase = 'Scrutiny') {
  const c = await lerGit(base, fase)
  if (!c) return { ok: false, semLeitura: true, motivo: 'conferência não retornou' }
  if (c.branch !== preparo.branch) return { ok: false, motivo: `branch mudou para "${c.branch}"` }
  const deFora = commitsDeFora(c, esperados)
  if (deFora.length) {
    const d = await julgarDeFora(c, deFora, fase)
    if (d.impacta) return { ok: false, motivo: `commit de fora da missão em ${base}..HEAD: ${deFora.join(', ')}. ${comoAceitar(c.head)}. ${d.motivo}` }
    // Aceito: passa a ser esperado no milestone (a lista do chamador é atualizada aqui) e o HEAD anda até ele.
    esperados.splice(0, esperados.length, ...c.commits)
    head = c.head
  }
  if (!arvoreLimpa(c)) return { ok: false, motivo: `árvore com mudanças não commitadas${pendenciasDe(c)}` }
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
  const r = await comRetentativa('suíte completa', () => trabalhar(montar('scrutiny',
    `${como} Faça isso no HEAD atual, sem alterar código. ${SAIDA_EM_ARQUIVO} ` +
    'Não rode comandos que alterem lockfiles ou dependências versionadas. Confira `git status` antes e depois: ao ' +
    'terminar, desfaça somente o que a própria suíte criou ou alterou (remova arquivos novos gerados por ela e use ' +
    '`git restore -- <path>` nos que ela modificou), deixando a árvore como estava. Esses arquivos são seus, não ' +
    'alheios: a proibição de restore abaixo não se aplica a eles.\n' +
    'Aprove só se tudo passar. Agrupe as falhas por causa provável: um problema por causa, não um por teste, com o ' +
    'arquivo provável e a saída relevante. Se a causa for de ambiente (serviço fora do ar, dependência ou ferramenta ' +
    'ausente, porta ocupada), marque ambiente=true e descreva o que faltou.' + memoria +
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
      `Revise os commits ${intervalo} do milestone "${m.titulo}" (critério: ${m.criterio}). ` +
      'Aponte só problemas bloqueantes de correção, segurança, contrato ou atomicidade dos commits.' + memoria +
      '\nSomente leitura. ' + SAIDA_EM_ARQUIVO + '\n' + GIT_PROIBIDO, guiasDe(m)),
      { label: `revisão: ${m.titulo}`, phase: 'Scrutiny', agentType: revisorPara(arquivos.map(normalizar)), schema: VALIDACAO },
    )),
    () => comRetentativa(`testes: ${m.titulo}`, () => trabalhar(montar('scrutiny',
      `Rode, no HEAD atual, os testes focados que cobrem os commits ${intervalo} do milestone "${m.titulo}" ` +
      `e confira o critério: ${m.criterio}. Não altere código. Reporte falhas com a saída relevante.` + memoria +
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
        properties: { arquivo: { type: 'string' }, problema: { type: 'string' }, repete: { type: 'boolean' } },
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
async function cacar(rotulo, areas, intervalo, foco, corrigidos) {
  const jaCorrigidos = corrigidos.length
    ? `\nJá corrigidos nesta missão (achou um deles de novo? marque repete=true): ${corrigidos.join(' | ')}`
    : ''
  const porArea = await parallel(areas.map(area => () => comRetentativa(`caça: ${area} (${rotulo})`, () => trabalhar(montar('caca-bug',
    `Cace bugs reais no diff \`git diff ${intervalo}\`, na área: ${area}. ${foco}${jaCorrigidos}\n` +
    'Devolva cada achado com o arquivo e o problema demonstrável (passo a passo ou teste que quebra). Sem achado, ' +
    `lista vazia. Não altere código. ${SAIDA_EM_ARQUIVO}\n${GIT_PROIBIDO}`),
    { label: `caça: ${area} (${rotulo})`, phase: 'Caça bug', schema: ACHADOS },
  ))))
  if (porArea.some(r => !r)) return { erro: `um caçador de bugs (${rotulo}) não respondeu` }
  const achados = porArea.flatMap(r => r.achados)
  const vereditos = await parallel(achados.map((a, i) => () => parallel([1, 2].map(n => () =>
    comRetentativa(`verificação ${n}: achado ${i + 1} (${rotulo})`, () => trabalhar(montar('caca-bug',
      `Tente refutar este possível bug em \`git diff ${intervalo}\`: ${textoDoAchado(a)}\n` +
      'Confirme (confirmado=true) só se reproduzir ou se o código não deixar dúvida; na dúvida, confirmado=false. ' +
      `Explique em motivo. Não altere código. ${SAIDA_EM_ARQUIVO}\n${GIT_PROIBIDO}`),
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
    `atendido=false e, em evidencia, o que falta para provar. Não altere código. ${SAIDA_EM_ARQUIVO}\n${GIT_PROIBIDO}`),
    { label: 'aceite', phase: 'Aceite', schema: ACEITE },
  ))
  if (!r) return { erro: 'o agente de aceite não respondeu' }
  if (!r.criterios.length) return { erro: 'o aceite não listou nenhum critério' }
  return { criterios: r.criterios, faltou: r.criterios.filter(c => !c.atendido) }
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
    `der para subir a stack (ambiente), marque ambiente=true.${memoria}\n${SAIDA_EM_ARQUIVO}\n${GIT_PROIBIDO}`, guiasDe(m)),
    { label: `user testing: ${m.titulo}`, phase: 'User testing', schema: VALIDACAO },
  ))
  if (!r) return { erro: 'o agente de user testing não respondeu' }
  if (!r.aprovado && r.problemas.length === 0) return { erro: 'user testing reprovou sem apontar problemas' }
  const deAmbiente = r.problemas.filter(p => p.ambiente)
  if (!r.aprovado && deAmbiente.length) {
    return { erro: `o user testing não roda por causa do ambiente: ${deAmbiente.map(p => p.problema).join(' | ')}. Ajuste o ambiente e retome` }
  }
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
    parouEm: m.titulo, ...extra, plano: { milestones }, contexto, aprendizados: contexto.aprendizados,
    retomar: { aPartirDe: m.titulo, branch: preparo.branch, inicioMissao: INICIO_MISSAO, base, head, commits: [...commits], concluidas, plano: { milestones }, contexto, deFora: [...deForaAceitos] },
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
    // Lê a missão inteira (INICIO_MISSAO..HEAD) para também recuperar os arquivos que ela já commitou.
    const c = await lerGit(INICIO_MISSAO, 'Preparar')
    const esperado = retomar.commits
    const desde = !c ? -1 : mesmoSha(base, INICIO_MISSAO) ? 0 : c.commits.findIndex(s => mesmoSha(s, base)) + 1
    const doMilestone = c && (desde > 0 || mesmoSha(base, INICIO_MISSAO)) ? c.commits.slice(desde) : null
    const intacto = c && doMilestone && c.branch === preparo.branch && (!retomar.branch || c.branch === retomar.branch) && mesmoSha(c.head, retomar.head) && mesmoSha(c.head, head) &&
      doMilestone.length === esperado.length && doMilestone.every((s, j) => mesmoSha(s, esperado[j])) &&
      (esperado.length > 0 || mesmoSha(base, head))
    if (!intacto) {
      // Devolve o `retomar` recebido, intacto, para o usuário ajustar e tentar de novo.
      return { ...parar(m, base, feitas, [], {
        motivo: c
          ? `repositório mudou desde a parada (branch ${c.branch}, esperada ${retomar.branch ?? preparo.branch}; HEAD ${c.head}, esperado ${retomar.head}; ${doMilestone?.length ?? 'base fora da missão, nenhum'} commits em ` +
            `${base}..HEAD, esperados ${esperado.length}). Desfaça as mudanças ou, se forem da missão, atualize ` +
            'retomar.head, retomar.commits e retomar.concluidas antes de retomar'
          : 'não foi possível ler o repositório para retomar',
      }, jaConcluidas), retomar }
    }
    // Arquivos que a missão já commitou, sem os dos commits de fora aceitos: commit de fora que tocar um deles para.
    for (const s of c.commits.filter(s => !deForaAceitos.some(d => mesmoSha(d, s)))) {
      for (const a of (c.arquivosPorCommit?.[s] ?? []).map(normalizar)) {
        arquivosDaMissao.add(a)
        if (doMilestone.includes(s)) arquivosDoMilestone.add(a)
      }
    }
    log(`Retomando "${m.titulo}" sobre ${base}: ${esperado.length} commits anteriores, ${jaConcluidas.length} itens ` +
      `concluídos, ${arquivosDaMissao.size} arquivos já tocados pela missão; orçamento de correções recomeça em ${MAX_RODADAS_CORRECAO} rodadas`)
  }
  const aFazer = m.features.filter(f => !jaConcluidas.includes(f.titulo))
  log(m.suite ? 'Suíte completa do projeto' : `Milestone: ${m.titulo} (${aFazer.length} de ${m.features.length} features a implementar)`)
  const pararAqui = extra => {
    if (extra.motivo) log(`Parando em "${m.titulo}": ${extra.motivo}`)
    return parar(m, base, feitas, commits, extra, jaConcluidas)
  }
  const features = aFazer.map(f => ({ ...f, guias: guiaPorFeature.has(f.titulo) ? [guiaPorFeature.get(f.titulo)] : [] }))
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
      spec: `Corrija: ${p}\n${m.suite ? 'Falha da suíte completa ao fim da missão' : `Milestone "${m.titulo}", critério: ${m.criterio}, commits ${base}..${head}`}.\n` +
        `Outros problemas da mesma rodada (podem ser duplicados deste ou já corrigidos): ${todos.filter((_, j) => j !== i).join(' | ') || 'nenhum'}.\n` +
        'Corrija a causa: não desative, pule nem enfraqueça testes, e não mexa em limites de cobertura para passar.',
      guias: guiasDoMilestone,
      etapa: 'corrigir',
    }))
    const fix = await implementar(correcoes, 'Corrigir')
    feitas.push(...fix.resultados)
    commits.push(...fix.commits)
    if (fix.falhou) return fix.falhou
    conf = await conferir(base, commits)
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
  }

  const impl = await implementar(features, 'Implementar')
  feitas.push(...impl.resultados)
  commits.push(...impl.commits)
  if (impl.falhou) return pararAqui(impl.falhou)

  conf = await conferir(base, commits)
  if (!conf.ok) return pararAqui({ motivo: conf.motivo })
  let e = null

  // Caça final, curta: uma rodada sobre o diff da missão inteira, focada na interação entre milestones. As correções
  // dela seguem para a suíte final logo abaixo. Retomando na suíte final, a caça final não se repete.
  if (m.suite && !retomando && milestones.length > 1) {
    const c = await cacar('final, rodada 1', ['interação entre milestones'], `${INICIO_MISSAO}..${head}`,
      `Foque na interação entre os milestones da missão (${milestones.map(x => x.titulo).join(', ')}): contratos entre ` +
      'eles, dados que um grava e outro lê, ordem de execução.', bugsCorrigidos)
    if (c.erro) return pararAqui({ motivo: c.erro })
    const repetidos = c.confirmados.filter(a => a.repete)
    if (repetidos.length) {
      return pararAqui({ motivo: 'a caça final confirmou de novo bug já corrigido nesta missão; decida à mão antes de retomar', problemas: repetidos })
    }
    bugsCorrigidos.push(...c.confirmados.map(textoDoAchado))
    if (c.confirmados.length) e = await rodadaDeCorrecao(c.confirmados)
    if (e) return pararAqui(e)
  }

  e = await scrutiny()
  if (e) return pararAqui(e)

  // Caça bug depois que o scrutiny passa: bug confirmado vira correção, volta ao scrutiny e a caça recomeça. Para na
  // rodada sem bug confirmado ou no teto; bug confirmado de novo depois de corrigido para a missão.
  if (!m.suite) {
    const areas = m.caca ?? await areasDeCaca(m, conf.arquivos)
    for (let r = 1; ; r++) {
      const c = await cacar(`${m.titulo}, rodada ${r}`, areas, `${base}..${head}`,
        `Milestone "${m.titulo}", critério: ${m.criterio}.`, bugsCorrigidos)
      if (c.erro) return pararAqui({ motivo: c.erro })
      if (!c.confirmados.length) break
      const repetidos = c.confirmados.filter(a => a.repete)
      if (repetidos.length) {
        return pararAqui({ motivo: 'a caça confirmou de novo bug já corrigido nesta missão; decida à mão antes de retomar', problemas: repetidos })
      }
      bugsCorrigidos.push(...c.confirmados.map(textoDoAchado))
      e = (await rodadaDeCorrecao(c.confirmados)) ?? await scrutiny()
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
  }

  // Os validadores rodam depois da última conferência: confirma que não sujaram a árvore nem commitaram.
  conf = await conferir(base, commits)
  if (!conf.ok) return pararAqui({ motivo: `após validação: ${conf.motivo}` })

  relatorio.push({ milestone: m.titulo, aprovado: true, rodadasCorrecao: rodada, commits: `${base}..${head}`, features: feitas })
}

return { concluido: true, branch: preparo.branch, base: INICIO_MISSAO, head, plano: { milestones }, aceite, contexto, aprendizados: contexto.aprendizados, relatorio }
