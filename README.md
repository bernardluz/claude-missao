# claude-missao

Workflow do Claude Code que executa um plano grande em **milestones**, no estilo das
[Factory Missions](https://docs.factory.ai/missions/overview): cada feature é implementada por um
agente novo, revisada por um revisor independente e commitada de forma atômica; cada milestone é
validado e corrigido em loop até fechar.

## Como funciona

```
Preparar      → árvore limpa, branch, HEAD e raiz, lidos pelo script git-estado.mjs
Simplicidade  → só com spec: confere a SPEC contra o código; pergunta ou corte PARA a missão
Planejar      → só com spec: gera o plano (milestones, features, critérios, caca, userTesting)
Pré-voo       → o ambiente roda testes e suíte? Falha para antes de qualquer commit
Contexto      → contexto do plano por área, gerado UMA vez e reaproveitado na retomada

Para cada milestone:
  Prova de contrato → premissas sobre outros serviços conferidas no código do dono; falsa PARA
  Para cada feature, em série:
    implementa (sem commit) → revisão independente → ajustes até aprovar → commit atômico → conferência
  Scrutiny ⇄ Corrigir   (testes, lint, typecheck e revisão contra o critério)
  Caça bug ⇄ Corrigir   (caçador por área; cada achado com 2 verificadores; só o confirmado vira correção)
  User testing ⇄ Corrigir   (só com m.userTesting: a jornada na stack local)

Caça final   → rodada curta sobre a missão inteira, focada na interação entre milestones
Suíte final  → suíte completa do que a missão tocou e de quem depende disso; cada falha vira correção
Aceite       → cada critério de aceite ligado a uma evidência; sem evidência vira correção uma vez
```

Cada correção vira uma feature, com revisão e commit próprios, e volta ao scrutiny. O loop segue
enquanto a avaliação aponta **menos** problemas que na rodada anterior. Ele para e devolve o
controle quando não há progresso, quando atinge o teto de rodadas ou quando uma rodada traz
problemas demais.

A caça bug para quando uma rodada não confirma nada, no teto `maxRodadasCaca` ou quando um bug
já corrigido é confirmado de novo (este último para a missão pedindo decisão).

### Etapas e skills

Cada etapa tem uma técnica curta e genérica em [`etapas/<etapa>.md`](etapas): `verificar-simplicidade`,
`planejar`, `pre-voo`, `prova-de-contrato`, `implementar`, `revisar`, `scrutiny`, `corrigir`, `caca-bug`,
`user-testing` e `aceite`. O prompt de cada etapa é a técnica dela, mais o trecho do contexto do plano
da área, mais os aprendizados da missão, mais a tarefa.

O projeto complementa uma etapa em `.claude/missao/etapas/<etapa>.md`: o texto dele vai depois do
núcleo. Se a primeira linha for `<!-- substitui -->`, o texto do projeto substitui o do núcleo. O
instalador embute tudo no `missao.js` gerado, porque o script do Workflow não lê arquivos.

**Aprendizados.** Todo worker pode devolver `aprendizados` (fato não óbvio, como "rode com
forks=1"). Eles vão para os próximos prompts, para `retomar.contexto` e para o resultado final em
`aprendizados`, para o agente principal levar ao `AGENTS.md` da área.

**SPEC simples.** A skill `criar-spec-simples`, instalada no projeto, orienta o agente principal a
escrever a SPEC na conversa, antes da missão: quem usa, fluxo em cliques, cada peça com uso real,
cortes explícitos e critérios de aceite verificáveis.

**Garantias:**

- **Commit só com revisão.** O agente de commit nunca altera código. Se um gate do commit falha, a
  falha vira ajuste e passa pela revisão de novo.
- **Recusa não é contornada.** Se o harness ou o classificador de permissões recusa um comando, o
  agente de commit não tenta de outro jeito: devolve o texto da recusa, e a missão para, porque a
  decisão é humana. Se o commit já tinha sido feito, ele entra no `retomar`.
- **Git conferido por script.** A conferência não depende da leitura de um modelo. Um agente barato
  (`modeloConferencia`) só roda `node .claude/missao/git-estado.mjs <base>` e devolve a saída literal.
  O workflow interpreta o JSON: branch, árvore limpa, a lista exata de commits em ordem e os arquivos.
  Saída inválida repete a leitura, nunca vira apontamento. A conferência roda logo depois de cada
  commit, quando `<HEAD anterior>..HEAD` precisa ter só o commit da feature, e de novo a cada milestone.
- **Commit de fora.** Commit de outra sessão ou automação que toca arquivo da missão para a missão
  na hora. Os demais vão para um agente (`modeloCommitDeFora`, sonnet com effort low), que decide se
  eles afetam algo de que a missão depende (build, dependências, migrations do mesmo módulo,
  contrato usado). Se não afetam, entram nos commits esperados e a missão segue, com registro no log.
  Se afetam, a missão para com o SHA no motivo. O commit da feature já entra no `retomar`. Para aceitar
  o commit de fora, ponha em `retomar.commits` a saída de `git rev-list --reverse <retomar.base>..HEAD`
  e em `retomar.head` o HEAD real. Para recusá-lo, tire-o do histórico e ajuste o `retomar`. Sem ajuste,
  a retomada recusa. O mesmo vale para um commit da feature com arquivo que a revisão não viu: ele
  fica fora do `retomar` até você decidir.
- **Saída em arquivo, nunca em pipe.** Os agentes mandam a saída de build, testes, gates e
  `git commit` para arquivo temporário e leem o arquivo depois. Um daemon deixado vivo pelo gate, como o
  do compilador Kotlin, herda o pipe e trava o comando.
- **Dump de crash do bash.** No Windows, `*.stackdump` não rastreado na raiz é dump de crash do bash. O
  agente de commit o apaga e a missão registra no log, sem apontamento para a feature. Até ele ser
  apagado, as conferências o toleram. Apagar qualquer outra coisa no repositório faz a missão parar.
- **Quedas retentadas com segurança.**
  - Agente que cai (modelo ou API) é retentado.
  - Worker que caiu deixando diff parcial é continuado por outro.
  - Commit que caiu depois de commitar só é adotado se tiver exatamente arquivos da feature
    revisada.
- **Retomada.** Toda parada devolve um objeto `retomar`. Passado em `args.retomar` numa nova
  execução, a missão continua do milestone interrompido, desde que o repositório esteja exatamente
  como ficou. O `retomar` traz o plano (`retomar.plano`) e o contexto do plano com os aprendizados
  (`retomar.contexto`): a retomada não replaneja nem regenera o contexto.

## Instalar num projeto

1. **Opcional:** crie `.claude/missao.config.json` no projeto. Veja [configuração](#configuração)
   e o exemplo em [`exemplos/brivae.config.json`](exemplos/brivae.config.json).
2. Gere a cópia instalada:

   ```bash
   node instalar.mjs ../meu-projeto
   ```

   Isso grava no projeto:
   - `.claude/workflows/missao.js`, com a configuração e a técnica de cada etapa embutidas;
   - `.claude/missao/git-estado.mjs`, o script que a conferência roda;
   - as skills `.claude/skills/missao-traycer/` e `.claude/skills/criar-spec-simples/`.

   Versione esses arquivos e a configuração no projeto. O complemento das etapas, se houver, fica em
   `.claude/missao/etapas/`.
3. Para saber se a cópia do projeto ficou desatualizada em relação a este repositório:

   ```bash
   node instalar.mjs ../meu-projeto --verificar
   ```

Não edite a cópia instalada. Altere o núcleo aqui, ou a configuração no projeto, e reinstale.
O instalador só sobrescreve um `missao.js` que ele mesmo gerou. Para substituir uma versão mantida à mão,
revise-a e use `--forcar`.

## Configuração

Todas as chaves são opcionais. Sem configuração, o workflow usa o agente padrão e textos genéricos.

| Chave | O que faz | Padrão |
|---|---|---|
| `regrasTestes` | Arquivo com a política de testes, citado aos workers | texto genérico |
| `regrasProjeto` | Arquivo que exige a revisão independente, citado aos workers | não cita |
| `revisor` | `agentType` do revisor (só leitura) | agente padrão |
| `revisoresPorPasta` | `[{ prefixo, agentType }]`: vale quando **todos** os arquivos estão no prefixo | `[]` |
| `leitor` | `agentType` só-leitura para simplicidade, plano, contexto, prova de contrato e conferência do git | agente padrão |
| `proibicoesExtras` | Proibições somadas às de git, por exemplo variáveis que desligam gates | `[]` |
| `formatoCommit` | Formato da mensagem de commit | `` `<tipo>: <descrição>` `` |
| `idioma` | Idioma da mensagem de commit | `pt-BR` |
| `exemplosSkills` | Exemplos de áreas de trabalho para o agente do contexto do plano | genérico |
| `suiteCompleta` | Como rodar, ao fim, a suíte completa do que a missão tocou e de quem depende disso. `{inicio}` vira o commit onde a missão começou | o agente acha módulos tocados e dependentes pelo `git diff` |
| `preVoo` | O que o pré-voo confere: comandos e requisitos da suíte e dos testes (ex.: Docker vivo, WSL com pwsh) | o agente descobre pelo plano |
| `modeloConferencia` | Modelo do agente que só roda o `git-estado.mjs` (e do que deriva as áreas de caça) | `haiku` |
| `modeloCommitDeFora` | Modelo do agente que decide se um commit de fora impacta a missão | `sonnet` |

Os `agentType` precisam existir no projeto, em `.claude/agents/`. Prefira um `revisor` e um `leitor` que
tenham só ferramentas de leitura. O agente padrão pode escrever e só obedece à instrução do prompt.

O instalador recusa chave desconhecida e tipo errado. O formato de `revisoresPorPasta` é conferido quando o
workflow roda.

## Rodar

Com o workflow instalado, peça ao Claude Code para rodar o workflow `missao` com `spec` ou com o
plano em `args`:

- **Com `spec`:** `{ "spec": "docs/specs/minha-entrega.md" }` (caminho no repositório ou o texto da
  SPEC). A missão confere a simplicidade, gera o plano e segue. Se a simplicidade trouxer perguntas
  ou cortes, ela para sem escrever código e devolve tudo em `perguntas` e `cortes`: decida, ajuste a
  SPEC e rode de novo. O plano gerado volta no resultado (`plano`) e em `retomar.plano`.
- **Com o plano:** `{ "milestones": [...] }` ou `{ "plano": { "milestones": [...] } }`. Pula a
  simplicidade e o planejamento.


Se o workflow tiver sido instalado com a sessão já aberta, ele ainda não aparece pelo nome, porque o
catálogo é carregado ao abrir a sessão. Nesse caso, rode pelo caminho
`.claude/workflows/missao.js`.

Plano de exemplo: [`exemplos/plano-teste.json`](exemplos/plano-teste.json). Ele cria só a pasta
descartável `missao-teste/`.

| `args` | Padrão | |
|---|---|---|
| `spec` | — | SPEC (caminho ou texto); obrigatório se não houver plano |
| `milestones` | — | `[{ titulo, criterio, caca?, userTesting?, features: [{ titulo, spec }] }]`, com títulos únicos. `caca`: áreas de caça-bug (sem ela, um agente barato as deriva dos arquivos tocados). `userTesting`: a jornada que um usuário percorre |
| `plano` | — | `{ milestones }`, o mesmo que `milestones` |
| `aceite` | — | Critérios de aceite. Sem eles, a seção de aceite da SPEC ou os critérios dos milestones |
| `maxRodadasCaca` | 3 | Teto de rodadas de caça bug por milestone |
| `maxFeaturesPorMilestone` | 8 | Plano com milestone maior é recusado; divida-o |
| `maxRodadasRevisao` | 3 | Rodadas de ajuste por feature antes de parar |
| `maxRodadasCorrecao` | 5 | Teto do loop validar/corrigir por milestone |
| `maxProblemasPorRodada` | 10 | Acima disso, o plano provavelmente está errado |
| `maxRetentativasInfra` | 2 | Retentativas quando um agente não retorna; `0` faz o pulo manual interromper |
| `retomar` | — | Objeto `retomar` devolvido pela execução que parou |
| `config` | — | Ajusta só `formatoCommit`, `idioma` e `exemplosSkills` nesta execução. Revisor, leitor e proibições vêm sempre da configuração instalada |

**Custo esperado:** cerca de `8 + 4 × features + 7 × milestones` agentes (mais 2 com `spec`, um
por área a mais de caça e um por user testing), sem contar correções, verificadores de achados e
retentativas. O log mostra a estimativa de cada execução. A suíte final pode levar muito tempo,
conforme o projeto.

O título `Suíte final` é reservado. Se a missão parar na suíte final, a retomada volta direto para ela.

## No Traycer: skill `missao-traycer`

O instalador também grava `.claude/skills/missao-traycer/SKILL.md` no projeto. A skill segue o mesmo
fluxo e as mesmas garantias, mas usa agentes e artefatos do Traycer em vez do Workflow:

| Workflow `missao` | Skill `missao-traycer` |
|---|---|
| Plano em `args` | Plano do usuário, de um artefato do epic ou em `args` |
| Progresso no painel | Milestones viram `story`, features e correções viram `ticket` com status, e apontamentos viram `review` |
| Configuração embutida na instalação | Lê `.claude/missao.config.json` ao rodar |
| Revisor novo a cada rodada | O **mesmo** revisor e o **mesmo** implementador por feature, continuando a conversa |
| Agente de commit | O coordenador commita os arquivos revisados e confere o commit |
| Objeto `retomar` | Spec `estado/` da missão no epic |

Para rodar, peça a um agente do Traycer para usar a skill `missao-traycer` com o plano. Ela depende do
agente seguir o texto, então não tem os testes com agentes falsos que o Workflow tem.

## Acompanhar

```bash
npm run painel
```

Abra http://127.0.0.1:4610. A porta pode ser trocada em `PAINEL_PORTA`.

O painel acha sozinho as missões de todos os projetos. Uma missão nova aparece sem configuração
nenhuma. A página mostra:
- a árvore de milestones e features, com o estado de cada uma;
- a etapa atual, as rodadas de ajuste e os apontamentos da revisão;
- as correções de cada milestone e os commits;
- os últimos agentes e o contexto do plano (áreas);
- **ao vivo:** o que o agente em curso está fazendo, passo a passo, a cada 2 segundos. Aparecem as mensagens,
  os comandos, os arquivos lidos e editados (com o diff) e o resultado de cada ferramenta. Clique em qualquer
  agente de uma feature, ou na atividade, para ver o que ele fez. O raciocínio interno não é gravado, só a marca
  de que o agente pensou.

Ela se atualiza a cada 5 segundos.

De onde vem cada informação, só por leitura:
- **Registros do Claude Code:** `~/.claude/projects/*/*/subagents/workflows/wf_*/`, ou `CLAUDE_CONFIG_DIR`.
  O `journal.jsonl` tem os agentes em ordem, com os resultados. Cada `agent-*.jsonl` tem o prompt,
  os horários e os tokens. O plano sai do prompt do agente `contexto do plano` (ou
  `skills da missão`, nas missões antigas). Contrato, caça bug e user testing aparecem nas validações
  de cada milestone.
- **Repositório:** o `git log` da própria missão.

**Limites da assinatura.** O topo da página mostra o uso da janela de 5 horas e o semanal, com o horário
em que cada um zera. Os dados vêm da statusline do Claude Code: `painel/statusline.mjs` lê o JSON que
o Claude Code manda para a statusline e grava `rate_limits` em `~/.claude/missao-painel/limites.json`.
Para ativar, ponha isto em `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "node \"<caminho>/claude-missao/painel/statusline.mjs\"", "padding": 0 }
```

A statusline só roda com uma sessão do Claude Code aberta no terminal, e só atualiza quando essa
sessão conversa com a API. Por isso o servidor do painel também consulta sozinho, a cada 10 minutos
(`PAINEL_LIMITES_MIN`; `0` desliga), sempre que a última leitura for mais velha que isso. A consulta
roda o `claude` CLI em modo não interativo, com o mínimo possível, e lê o evento `rate_limit_event`
da saída:
- Haiku, sem ferramentas, sem MCP, sem settings do usuário;
- sem salvar a sessão, com prompt curto e pasta vazia.

Cada consulta leva cerca de 850 tokens e não carrega settings nem hooks do usuário. O intervalo tem piso de 5 minutos, e cada consulta sem resultado dobra a espera, até 1 hora. O limite semanal por modelo e o uso extra não vêm em
nenhuma das duas fontes, por isso não aparecem.

O servidor só escuta em 127.0.0.1 e recusa requisições cujo Host não seja `127.0.0.1` ou
`localhost`. Algumas regras de leitura:
- **Retomada:** a execução retomada entra na mesma missão da que parou, porque as duas têm o mesmo
  repositório e o mesmo último milestone. Uma retomada que começa direto na suíte final entra na
  missão aberta mais recente do repositório.
- **Recomeço:** um plano que recomeça num milestone já validado, ou que roda depois de uma missão
  concluída, vira outra missão.
- **Parada:** a execução conta como parada em dois casos:
  - com agente rodando, depois de 20 minutos sem nenhum arquivo novo, porque uma chamada de
    ferramenta longa não escreve nada;
  - sem agente rodando, depois de 3 minutos, porque a missão lança o próximo agente na hora.

## Limitações

- **Workers não lançam subagentes.** No Workflow, os agentes não têm a ferramenta `Agent`, nem com
  `agentType: general-purpose`. Por isso quem chama o revisor é o script.
- **Revisor novo a cada rodada.** O Workflow não continua uma conversa, então cada rodada de revisão
  usa um revisor novo, que recebe os apontamentos da rodada anterior.
- **Caminhos.** Caminho relativo a uma subpasta e grafias raras do Windows (nome curto 8.3, junction,
  WSL) não são convertidos. Nesses casos a missão para, em vez de commitar algo errado.
- **Nomes das features.** Não renomeie features entre uma execução e a retomada: o que já foi feito
  é reconhecido pelo título exato.
- **Técnica das etapas só na cópia instalada.** O script do Workflow não lê arquivos: a técnica de
  cada etapa entra na instalação. O núcleo rodado direto funciona, mas sem ela. Mudou `etapas/` ou o
  complemento do projeto, reinstale.
- **Commit de fora julgado só na conferência.** O agente que julga impacto roda nas conferências
  depois do commit e do milestone. Commit de fora percebido quando um worker cai, ou que leva o diff
  da feature, ainda para a missão como antes.
- **Bug repetido.** Quem diz que um achado repete um bug já corrigido é o caçador, a partir da lista
  de corrigidos que recebe; não há comparação textual.
- **Caça final na retomada.** Retomando direto na suíte final, a caça final não se repete.

## Desenvolvimento

```bash
npm test
```

Os testes rodam o workflow com agentes falsos e um git simulado ([`teste/simulador.mjs`](teste/simulador.mjs)).
Eles cobrem spec e plano, pré-voo, prova de contrato, o fluxo por feature, a conferência por script depois
de cada commit, commit de fora, scrutiny, caça bug, user testing, caça final, aceite, quedas, retomada com
contexto e aprendizados, configuração e o instalador.
