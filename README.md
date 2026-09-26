# claude-missao

Workflow do Claude Code que executa um plano grande em **milestones**, no estilo das
[Factory Missions](https://docs.factory.ai/missions/overview): cada feature é implementada por um
agente novo, revisada por um revisor independente e commitada de forma atômica; cada milestone é
validado e corrigido em loop até fechar.

## Como funciona

```
Preparar      → branch, HEAD, raiz e a sujeira que já existe (linha de base), lidos pelo git-estado.mjs
Simplicidade  → só com spec: confere a SPEC contra o código; só decisão de produto ou risco PARA a missão
Planejar      → só com spec: gera o plano (milestones, features, critérios, caca, userTesting)
Pré-voo       → o ambiente roda testes e suíte? Falha para antes de qualquer commit
Contexto      → contexto do plano por área, gerado UMA vez e reaproveitado na retomada

Para cada milestone:
  Prova de contrato → premissas sobre outros serviços conferidas no código do dono; trivial é corrigida
                      pelo valor real, só divergência de comportamento, contrato ou risco PARA
  UI/UX             → só com tela: desenha telas e fluxos com checklist de UX, sem esperar aprovação
  Para cada feature, em série:
    implementa (worker nunca commita) → revisão independente → ajustes até aprovar → leitura do git →
    commit fixo da lista → conferência
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

### UI/UX

Em milestone com tela, depois da prova de contrato e antes de implementar, um agente desenha as telas e fluxos. Usa a
skill `/design`, a `impeccable` ou o Artifact de design quando disponível e devolve os links; senão, o desenho em
texto, por tela. O checklist de UX fica em `etapas/ui-ux.md`: nunca pedir ID ou UUID digitado (sempre seletor
pesquisável), pontos de entrada nas telas relacionadas, estados de carregando, vazio, erro e sucesso, confirmação em ação
destrutiva, linguagem do usuário, acessibilidade e componentes do design system.

A etapa **nunca para a missão** esperando aprovação. O desenho vai para implementar, correção, revisão (achado grave de
UX, como pedir ID na mão, bloqueia o commit) e user testing, que registra os desvios. Ele vai no `retomar` e, no fim,
em `resultado.designs` (por milestone: links, texto e desvios). O usuário revisa no fim e, se não gostar, roda o
design à parte.

### Etapas e skills

Cada etapa tem uma técnica curta e genérica em [`etapas/<etapa>.md`](etapas): `verificar-simplicidade`,
`planejar`, `pre-voo`, `prova-de-contrato`, `implementar`, `revisar`, `scrutiny`, `corrigir`, `caca-bug`,
`user-testing` e `aceite`. O prompt de cada etapa é a técnica dela, mais o trecho do contexto do plano
da área, mais os aprendizados da missão, mais a tarefa.

O projeto complementa uma etapa em `.claude/missao/etapas/<etapa>.md`: o texto dele vai depois do
núcleo. Se a primeira linha for `<!-- substitui -->`, o texto do projeto substitui o do núcleo. O
instalador embute tudo no `missao.js` gerado, porque o script do Workflow não lê arquivos.

**Aprendizados.** Todo worker pode devolver até 3 `aprendizados`: só técnica ou armadilha durável (como
"rode com forks=1"), nunca estado do momento. Repetidos e o que já está no `aprendizados.md` do projeto são
descartados. Os demais vão para os próximos prompts, para `retomar.contexto` e para o resultado em
`aprendizados`, junto com `sugestaoAprendizados`: texto pronto para o agente principal revisar e acrescentar a
`.claude/missao/aprendizados.md`. Esse arquivo, opcional, é embutido pelo instalador e entra em todo prompt de
etapa como "Aprendizados do projeto"; mudou, reinstale (`--verificar` acusa).
Como vai em todo prompt, o arquivo precisa de curadoria: junte repetidos, corte o que envelheceu e mantenha só
técnica e armadilha durável. O instalador avisa, sem falhar, quando ele passa de 60 linhas.

**Prova de contrato.** O provador recebe o plano do milestone e a SPEC. Premissa que não confere e é só fato
descritivo de código que já existe no dono (contagem de chamadas, caminho, nome atual de símbolo ou campo) é
decidida: a spec da feature indicada recebe o valor real e a correção entra em `decisoesAssumidas`, para você
revisar no fim. O que o plano ou a SPEC marca como decisão não é premissa a provar: a missão segue a decisão.
Para a missão: escolha para código novo (número de migration, tabela ou rota nova, contrato novo) que o plano não
fixou, conflito concreto no código com uma decisão do plano (ex.: já existe arquivo com o mesmo número de
migration), divergência que muda comportamento ou contrato, ou que envolve dinheiro, acesso ou dado sensível sem
resposta no código. Uma trava no código nunca decide premissa de migration (arquivo `V71__x.sql`, ou palavra
migration, migração ou Flyway junto com um número de versão como V71).

**SPEC simples.** A skill `criar-spec-simples`, instalada no global, orienta o agente principal a
escrever a SPEC na conversa, antes da missão: quem usa, fluxo em cliques, cada peça com uso real,
cortes explícitos e critérios de aceite verificáveis.

**Garantias:**

- **Commit por feature, feito pela missão.** O worker nunca commita: devolve a lista de arquivos (renomeação
  com origem e destino) e a mensagem do commit no formato do projeto. Depois da revisão aprovada, a missão lê
  o git: mudança nova fora da lista (e fora da linha de base, da sujeira alheia já vista e do `naoSao` do
  worker) volta ao worker para declarar ou desfazer. Aí um agente barato só executa o comando fixo
  `git add -- <lista> && git commit -F <mensagem> -- <lista>`. Se um gate do commit falha, a falha vira
  ajuste e passa pela revisão de novo. Depois do commit, a conferência separa os commits do intervalo: da
  feature (só arquivos da lista, inclusive um que o worker tenha feito sozinho), de fora (aceito) ou misto
  (arquivo da feature com arquivo não revisado: fica fora do `retomar` e a missão para).
- **Recusa não é contornada.** Se o harness ou o classificador de permissões recusa o comando de commit, o
  agente não tenta de outro jeito: devolve o texto da recusa, e a missão para, porque a decisão é humana. Se
  o commit já tinha sido feito, ele entra no `retomar`.
- **Git conferido por script.** A conferência não depende da leitura de um modelo. Um agente barato
  (`modeloConferencia`) só roda `node .claude/missao/git-estado.mjs <base>` e devolve a saída literal.
  O workflow interpreta o JSON: branch, árvore limpa, a lista exata de commits em ordem e os arquivos.
  Saída inválida repete a leitura, nunca vira apontamento. A conferência roda logo depois de cada
  commit, quando `<HEAD anterior>..HEAD` precisa ter só o commit da feature, e de novo a cada milestone.
- **Commit de fora nunca para a missão.** Commit de outra sessão ou automação é sempre aceito: entra nos
  commits esperados e em `retomar.deFora`, não conta como da missão, e a missão segue com registro no log. Os
  workers continuam commitando só os próprios caminhos (`git add -- <paths>`).
  - Se ele toca arquivo da missão, o log diz `commit de fora aceito, toca a missão: <shas>`, e os arquivos vão em
    `deForaTocando` (no `retomar` e no resultado final). O scrutiny e a caça do milestone, a caça final e a suíte
    recebem "arquivos da missão tocados por commit de fora: revise-os".
  - Se ele levou o diff da feature (ex.: `git commit -a` de outra sessão) e nenhum arquivo dela ficou pendente na
    árvore, a feature conta como concluída. Se o diff ainda está na árvore (ex.: `index.lock`), a missão para como
    antes: é problema de lock, não de commit de fora.
  - Commit da própria feature com arquivo que a revisão não viu não é de fora: fica fora do `retomar` até você
    decidir, como antes.
- **Saída em arquivo, nunca em pipe.** Os agentes mandam a saída de build, testes, gates e
  `git commit` para arquivo temporário e leem o arquivo depois. Um daemon deixado vivo pelo gate, como o
  do compilador Kotlin, herda o pipe e trava o comando.
- **Árvore suja não para a missão.** O que já estava sem commit no início vira linha de base
  (`sujeiraInicial`, levada no `retomar`) e fica fora dos commits. Cada commit leva só os arquivos que o
  worker declarou (`git add`/`git commit -- <lista>`, nunca `git add -A`). Arquivo da linha de base que o
  worker editou vai inteiro e vira aviso em `resultado.sujeiraCommitada`. Sujeira de outras sessões no meio
  da missão também não para nem entra nos commits.
- **Quedas retentadas com segurança.**
  - Agente que cai (modelo ou API) é retentado.
  - Worker que caiu deixando diff parcial é continuado por outro.
  - Commit que caiu depois de commitar só é adotado se tiver exatamente arquivos da feature
    revisada.
- **Retomada.** Toda parada devolve um objeto `retomar`. Passado em `args.retomar` numa nova
  execução, a missão continua do milestone interrompido, desde que o repositório esteja exatamente
  como ficou. O `retomar` traz o plano (`retomar.plano`) e o contexto do plano com os aprendizados
  (`retomar.contexto`): a retomada não replaneja e só regenera o contexto se ele ficou sem áreas. Leva também os
  commits de fora aceitos (`deFora`) e os que tocam a missão (`deForaTocando`), os bugs corrigidos pela caça (`bugsCorrigidos`) e se a caça final já rodou
  (`cacaFinalFeita`). Na retomada, os arquivos que a missão já tocou vêm do git.

## Modo enxugar

Para pegar um código que já existe e cortá-lo ao modelo mínimo, com os mesmos processos da missão:

1. **Na conversa**, o agente principal usa a skill `enxugar-codigo`: radiografia medida do alvo (linhas, tabelas,
   filas, jobs, estados, rotas, testes), uso real de cada peça, peso x valor, e as decisões do usuário uma por vez.
2. **SPEC**, no formato da `criar-spec-simples`, com `<!-- modo: enxugar -->` na primeira linha e as seções
   "Estado atual (medido)", "Modelo alvo", "O que sai", "Consumidores que mudam junto" e "Estratégia de corte"
   (reconstruir do zero x cirurgia, hardcut x migration de avanço, ordem de deploy).
3. **Missão** com `{ "spec": "<caminho>", "modo": "enxugar" }`. As etapas com complemento
   `etapas/<etapa>.enxugar.md` (simplicidade, planejar, pré-voo, contrato, implementar, caça bug e aceite) recebem a
   técnica ajustada para código existente. O pré-voo mede o alvo no início, o aceite mede do mesmo jeito no fim, e o
   resultado traz `medicao: { antes, depois }` para a tabela antes x depois da SPEC.

Referência: um serviço financeiro saiu de 23 mil linhas, 34 tabelas e 6 fluxos de mensageria para 3,8 mil linhas,
6 tabelas e nenhuma fila.

## Instalar

A missão tem duas partes: as skills, uma vez por máquina, e o workflow, em cada projeto.

**Skills no global** (Claude e Codex):

```bash
node instalar.mjs --global      # grava ou atualiza as skills
node instalar.mjs --verificar   # sai com código 1 se estiverem desatualizadas
```

Isso grava `criar-spec-simples` e `enxugar-codigo` em `~/.claude/skills/` e `~/.codex/skills/`, substituindo
cópias antigas. A `missao-traycer` não é instalada no global: o `--global` remove a cópia global dela que tiver
a marca do instalador. Na hora de instalar, o caminho deste repositório e a URL do
`origin` entram no texto de cada skill, com uma seção "Atualizar a missão" que ensina a pegar atualização.
Nada da máquina fica versionado aqui. Projeto não guarda cópia das skills.

**Workflow num projeto:**

1. **Opcional:** crie `.claude/missao.config.json` no projeto. Veja [configuração](#configuração)
   e o exemplo em [`exemplos/brivae.config.json`](exemplos/brivae.config.json).
2. Gere a cópia instalada:

   ```bash
   node instalar.mjs ../meu-projeto
   ```

   Isso grava no projeto só:
   - `.claude/workflows/missao.js`, com a configuração, a técnica de cada etapa e os aprendizados embutidos;
   - `.claude/missao/git-estado.mjs`, o script que a conferência roda.

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

Os `agentType` precisam existir no projeto, em `.claude/agents/`. Prefira um `revisor` e um `leitor` que
tenham só ferramentas de leitura. O agente padrão pode escrever e só obedece à instrução do prompt.

O instalador recusa chave desconhecida e tipo errado. O formato de `revisoresPorPasta` é conferido quando o
workflow roda.

## Rodar

Com o workflow instalado, peça ao Claude Code para rodar o workflow `missao` com `spec` ou com o
plano em `args`:

- **Com `spec`:** `{ "spec": "docs/specs/minha-entrega.md" }` (caminho no repositório ou o texto da
  SPEC). A missão confere a simplicidade, gera o plano e segue. Cada pergunta ou corte da simplicidade
  vem classificado:
  - **decidido** (tem sugestão e é técnico ou de desenho interno): a missão segue com a sugestão, que vai
    ao planejador como decisão assumida e volta em `decisoesAssumidas` no resultado e no `retomar`,
    para você revisar no fim;
  - **bloqueante** (produto ou risco, como dinheiro, acesso ou dado sensível, sem resposta na SPEC nem no
    código, ou corte de algo que a SPEC pede): a missão para sem escrever código e devolve os itens em
    `bloqueantes`. Decida, ajuste a SPEC e rode de novo.

  O plano gerado volta no resultado (`plano`) e em `retomar.plano`. Se o planejador usar o título
  reservado "Suíte final", o milestone é renomeado para "Milestone final".
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
| `milestones` | — | `[{ titulo, criterio, caca?, userTesting?, ui?, features: [{ titulo, spec }] }]`, com títulos únicos. `caca`: áreas de caça-bug (sem ela, um agente barato as deriva dos arquivos tocados). `userTesting`: a jornada que um usuário percorre. `ui`: as telas e fluxos do milestone (sem ela, um agente barato detecta se há tela) |
| `plano` | — | `{ milestones }`, o mesmo que `milestones` |
| `aceite` | — | Critérios de aceite (lista, ou um texto só). Sem eles, a seção de aceite da SPEC ou os critérios dos milestones |
| `maxRodadasCaca` | 3 | Teto de rodadas de caça bug por milestone |
| `modo` | — | `"enxugar"` para cortar código que já existe (também ligado pelo marcador `<!-- modo: enxugar -->` na SPEC em texto) |
| `maxFeaturesPorMilestone` | 8 | Plano com milestone maior é recusado; divida-o |
| `maxRodadasRevisao` | 3 | Rodadas de ajuste por feature antes de parar |
| `maxRodadasCorrecao` | 5 | Teto do loop validar/corrigir por milestone |
| `maxProblemasPorRodada` | 10 | Acima disso, o plano provavelmente está errado |
| `maxRetentativasInfra` | 2 | Retentativas quando um agente não retorna; `0` faz o pulo manual interromper |
| `retomar` | — | Objeto `retomar` devolvido pela execução que parou |
| `config` | — | Ajusta só `formatoCommit`, `idioma` e `exemplosSkills` nesta execução. Revisor, leitor e proibições vêm sempre da configuração instalada |

**Custo esperado:** cerca de `8 + 5 × features + 7 × milestones` agentes (mais 2 com `spec`, um
por área a mais de caça e um por user testing), sem contar correções, verificadores de achados e
retentativas. O log mostra a estimativa de cada execução. A suíte final pode levar muito tempo,
conforme o projeto.

O título `Suíte final` é reservado. Se a missão parar na suíte final, a retomada volta direto para ela.

## No Traycer: skill `missao-traycer`

A skill `missao-traycer` fica só neste repositório, em `skills/missao-traycer/`: não é instalada no global nem no
projeto. Para usar, aponte o agente do Traycer para esse arquivo. Ela lê as técnicas das etapas e o
`git-estado.mjs` deste repositório, e a configuração do projeto atual; se o projeto não tiver a missão instalada,
ela manda instalar. Segue o mesmo fluxo e as mesmas garantias, mas usa agentes e artefatos do Traycer em vez do
Workflow:

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
- **Commit de fora percebido quando um worker cai.** Se o worker cai e o histórico mudou, a missão não sabe
  se o commit é dele ou de outra sessão, e para como antes. Commit de fora percebido depois do último
  scrutiny do milestone só é revisado na caça final e na suíte.
- **Bug repetido.** Quem diz que um achado repete um bug já corrigido é o caçador, a partir da lista
  de corrigidos que recebe; não há comparação textual.

## Desenvolvimento

```bash
npm test
```

Os testes rodam o workflow com agentes falsos e um git simulado ([`teste/simulador.mjs`](teste/simulador.mjs)).
Eles cobrem spec e plano, pré-voo, prova de contrato, o fluxo por feature, a conferência por script depois
de cada commit, commit de fora, scrutiny, caça bug, user testing, caça final, aceite, quedas, retomada com
contexto e aprendizados, configuração e o instalador.
