# claude-missao

Workflow do Claude Code que executa um plano grande em **milestones**, no estilo das
[Factory Missions](https://docs.factory.ai/missions/overview): cada feature é implementada por um
agente novo, revisada por um revisor independente e commitada de forma atômica; cada milestone é
validado e corrigido em loop até fechar.

## Como funciona

```
Preparar  → confere árvore limpa, branch, HEAD e raiz do repositório
Skills    → um agente só-leitura escreve guias por tipo de feature (vivem só na execução)

Para cada milestone:
  Para cada feature, em série:
    implementa (sem commit) → revisão independente → ajustes até aprovar → commit atômico
  Validar ◄───────────────────────────┐
     │ aprovou? não → Corrigir (cada problema vira uma feature, com revisão e commit próprios)
     ▼ sim
  próximo milestone

Suíte final → suíte completa do que a missão tocou e de quem depende disso; cada falha vira correção
```

O loop de correção segue enquanto a validação aponta **menos** problemas que na rodada anterior.
Ele para e devolve o controle quando não há progresso, quando atinge o teto de rodadas ou quando
uma rodada traz problemas demais.

**Garantias:**

- **Commit só com revisão.** O agente de commit nunca altera código. Se um gate do commit falha, a
  falha vira ajuste e passa pela revisão de novo.
- **Recusa não é contornada.** Se o harness ou o classificador de permissões recusa um comando, o
  agente de commit não tenta de outro jeito: devolve o texto da recusa, e a missão para, porque a
  decisão é humana. Se o commit já tinha sido feito, ele entra no `retomar`.
- **Git conferido.** Um agente só-leitura confere o git real, sem confiar no relato dos workers:
  branch, árvore limpa e a lista exata de commits. Commit de outra sessão no intervalo faz a missão
  parar.
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
  como ficou.

## Instalar num projeto

1. **Opcional:** crie `.claude/missao.config.json` no projeto. Veja [configuração](#configuração)
   e o exemplo em [`exemplos/brivae.config.json`](exemplos/brivae.config.json).
2. Gere a cópia instalada:

   ```bash
   node instalar.mjs ../meu-projeto
   ```

   Isso grava `.claude/workflows/missao.js` no projeto, com a configuração embutida. Versione os
   dois arquivos no projeto.
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
| `leitor` | `agentType` só-leitura para as skills e a conferência do git | agente padrão |
| `proibicoesExtras` | Proibições somadas às de git, por exemplo variáveis que desligam gates | `[]` |
| `formatoCommit` | Formato da mensagem de commit | `` `<tipo>: <descrição>` `` |
| `idioma` | Idioma da mensagem de commit | `pt-BR` |
| `exemplosSkills` | Exemplos de tipos de trabalho para o agente das skills | genérico |
| `suiteCompleta` | Como rodar, ao fim, a suíte completa do que a missão tocou e de quem depende disso. `{inicio}` vira o commit onde a missão começou | o agente acha módulos tocados e dependentes pelo `git diff` |

Os `agentType` precisam existir no projeto, em `.claude/agents/`. Prefira um `revisor` e um `leitor` que
tenham só ferramentas de leitura. O agente padrão pode escrever e só obedece à instrução do prompt.

O instalador recusa chave desconhecida e tipo errado. O formato de `revisoresPorPasta` é conferido quando o
workflow roda.

## Rodar

Com o workflow instalado, peça ao Claude Code para rodar o workflow `missao` com o plano em `args`.
Se o workflow tiver sido instalado com a sessão já aberta, ele ainda não aparece pelo nome, porque o
catálogo é carregado ao abrir a sessão. Nesse caso, rode pelo caminho
`.claude/workflows/missao.js`.

Plano de exemplo: [`exemplos/plano-teste.json`](exemplos/plano-teste.json). Ele cria só a pasta
descartável `missao-teste/`.

| `args` | Padrão | |
|---|---|---|
| `milestones` | obrigatório | `[{ titulo, criterio, features: [{ titulo, spec }] }]`, com títulos únicos |
| `maxFeaturesPorMilestone` | 8 | Plano com milestone maior é recusado; divida-o |
| `maxRodadasRevisao` | 3 | Rodadas de ajuste por feature antes de parar |
| `maxRodadasCorrecao` | 5 | Teto do loop validar/corrigir por milestone |
| `maxProblemasPorRodada` | 10 | Acima disso, o plano provavelmente está errado |
| `maxRetentativasInfra` | 2 | Retentativas quando um agente não retorna; `0` faz o pulo manual interromper |
| `retomar` | — | Objeto `retomar` devolvido pela execução que parou |
| `config` | — | Ajusta só `formatoCommit`, `idioma` e `exemplosSkills` nesta execução. Revisor, leitor e proibições vêm sempre da configuração instalada |

**Custo esperado:** `5 + 3 × features + 4 × milestones` agentes, sem contar correções e
retentativas. A suíte final pode levar muito tempo, conforme o projeto.

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
- os últimos agentes e as skills;
- **ao vivo:** o que o agente em curso está fazendo, passo a passo, a cada 2 segundos. Aparecem as mensagens,
  os comandos, os arquivos lidos e editados (com o diff) e o resultado de cada ferramenta. Clique em qualquer
  agente de uma feature, ou na atividade, para ver o que ele fez. O raciocínio interno não é gravado, só a marca
  de que o agente pensou.

Ela se atualiza a cada 5 segundos.

De onde vem cada informação, só por leitura:
- **Registros do Claude Code:** `~/.claude/projects/*/*/subagents/workflows/wf_*/`, ou `CLAUDE_CONFIG_DIR`.
  O `journal.jsonl` tem os agentes em ordem, com os resultados. Cada `agent-*.jsonl` tem o prompt,
  os horários e os tokens. O plano sai do prompt do agente `skills da missão`.
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

## Desenvolvimento

```bash
npm test
```

Os testes rodam o workflow com agentes falsos e um git simulado ([`teste/simulador.mjs`](teste/simulador.mjs)).
Eles cobrem o fluxo por feature, o loop de correção, quedas, retomada, configuração e o instalador.
