---
name: missao-traycer
description: "Executa no Traycer um plano grande em milestones e features, com as garantias do claude-missao: uma feature por vez com agente próprio, revisão independente antes de cada commit atômico, git conferido, loop validar/corrigir que para quando não progride e retomada. Milestones viram stories e features viram tickets. Use quando o usuário pedir missão, missao-traycer ou execução de plano em milestones no Traycer."
---

# Missão no Traycer

Você é o **coordenador**. Agentes filhos implementam e revisam; você cuida do plano, dos artefatos, do git e dos
commits. Você nunca escreve código de produto. Instalada pelo `claude-missao`: edite lá, não a cópia no projeto.

Antes de despachar, leia `../traycer-references/loop-protocol.md` se ele existir. Toda passagem de trabalho vai com
`expectReply: true`. Depois de despachar, **encerre o turno**: a resposta do filho é o que te acorda. Nunca termine um
turno com trabalho em aberto e ninguém devendo o próximo passo.

## Entrada

O plano vem do usuário, de um artefato do epic ou de `args`:
`milestones: [{ titulo, criterio, features: [{ titulo, spec }] }]`, com títulos únicos.

| Limite | Padrão | Ao estourar |
|---|---|---|
| `maxFeaturesPorMilestone` | 8 | recuse o plano e peça para dividir o milestone |
| `maxRodadasRevisao` | 3 | rodadas de ajuste por feature; depois disso, pare |
| `maxRodadasCorrecao` | 5 | teto do loop validar/corrigir por milestone |
| `maxProblemasPorRodada` | 10 | acima disso o plano provavelmente está errado: pare |
| `maxRetentativasInfra` | 2 | agente que caiu ou sumiu; `0` faz a primeira queda parar a missão |

Plano ambíguo ou sem critério de aceite: resolva **antes** de começar, com uma pergunta por vez. Durante a missão,
o usuário só é chamado nas paradas.

## Configuração do projeto

Leia `.claude/missao.config.json` se existir. As chaves são as mesmas do workflow `missao`:

- `regrasTestes`, `regrasProjeto`: arquivos citados aos filhos.
- `revisor`, `revisoresPorPasta`, `leitor`: nomes em `.claude/agents/`. O filho Traycer recebe a instrução de ler
  `.claude/agents/<nome>.md` e seguir aquele papel, só com leitura.
- `proibicoesExtras`, `formatoCommit`, `idioma`, `exemplosSkills`, `suiteCompleta`: veja o README do claude-missao.

O revisor vem **sempre** da configuração. Nem o plano nem o usuário no meio da execução o desligam.

## Artefatos

Tudo no epic atual. Crie ao preparar a missão:

```
missao-<slug>/            story   "Missão: <nome>"            status 0→1→2
  estado/                 spec    estado para retomada (abaixo)
  guias/                  spec    guias da missão por tipo de feature
  m1-<slug>/              story   milestone com o critério de aceite
    f1-<slug>/            ticket  feature: spec, arquivos, rodadas, commit
      revisao-1/          review  apontamentos de cada rodada
    c1-<slug>/            ticket  correção vinda da validação
  suite-final/            story   só se chegar lá
```

`estado/index.md` é a fonte da retomada. Atualize-o **a cada passo concluído**, sem esperar o fim do milestone:
raiz do repo, branch, commit inicial (`inicio`), HEAD esperado, lista de commits por feature (`sha`, título,
arquivos), milestone e feature atuais, rodada de correção e contagem de problemas da rodada anterior.

## Fluxo

### 1. Preparar

Rode você mesmo e confira: raiz (`git rev-parse --show-toplevel`), branch, `git status --porcelain` vazio e HEAD.
Árvore suja ou branch `main`: pare e diga por quê. Grave `inicio` = HEAD no estado.

### 2. Guias da missão

Um filho só-leitura (papel `leitor`) lê o plano e o código e escreve em `guias/` um guia curto por tipo de feature
(ex.: `exemplosSkills`): arquivos de referência, padrões, testes focados. Os guias vivem só nesta missão. Nunca vão
para `.claude/skills/`.

### 3. Cada feature, em série

Uma feature por vez. Ticket em status 1.

1. **Implementar.** Crie um filho novo (`traycer_create_agent`, mesmo workspace) e mande: spec da feature, guia do
   tipo, `regrasTestes`, `regrasProjeto`. Proibido: commit, amend, stash, push, trocar de branch, reset/checkout
   destrutivo, `--no-verify`, criar agentes e `proibicoesExtras`. Ele escreve os próprios testes. Se a feature
   usar escape Unicode, inclua o aviso de [Escapes Unicode](#escapes-unicode). Peça de volta: arquivos alterados,
   testes rodados e resultado.
2. **Conferir o git.** Não confie no relato. Confira HEAD igual ao esperado (sem commit de outra sessão) e
   `git status --porcelain` com o conjunto real de arquivos. Arquivo fora do escopo da feature volta ao
   implementador como ajuste.
3. **Revisar.** Na primeira rodada, crie **um** revisor para a feature: papel de `revisoresPorPasta` quando todos
   os arquivos estão no prefixo, senão `revisor`. Ele só lê. Passe a spec e o `git diff` dos arquivos. Resposta:
   `aprovado` ou apontamentos bloqueantes, cada um com arquivo e motivo. Quem registra a resposta em `revisao-<n>/`
   é você: o revisor só lê e não cria artefato.
4. **Ajustar.** Com apontamentos, devolva-os ao **mesmo** implementador. Na volta, repita o passo 2 e mande o novo
   diff ao **mesmo** revisor, continuando a conversa. Passou de `maxRodadasRevisao`: pare.
5. **Commit.** Só com `aprovado` na última rodada e sem mudança depois dela. Você commita, sem tocar no código:
   `git add -- <arquivos revisados>` e `git commit -F <arquivo no scratchpad> -- <arquivos revisados>`, no
   `formatoCommit` e no `idioma`, com as linhas de atribuição da sessão. Gate do commit falhou: a saída vira
   apontamento para o implementador e a feature volta ao passo 4 (nova revisão).
6. **Conferir o commit.** `git show --name-only --format='%H %P' HEAD`: o pai é o HEAD esperado e os arquivos são
   exatamente os revisados. Árvore limpa depois. Grave no estado e no ticket. Ticket em status 2. Arquive os dois
   filhos (`traycer_archive_agent`).

### 4. Validar o milestone

Um filho novo, papel `revisor`, só leitura quanto ao código, mas pode rodar testes focados conforme `regrasTestes`.
Passe o critério do milestone e o intervalo `<commit antes do milestone>..HEAD`. Resposta: `aprovado` ou uma lista
de problemas, cada um com evidência (arquivo, teste, saída).

- **Aprovado:** story do milestone em status 2. Próximo milestone.
- **Problemas:** cada um vira um ticket `c<n>-…` e segue o fluxo do passo 3 inteiro, com revisão e commit próprios.
  Depois, valide de novo com um validador novo.

O loop continua enquanto cada rodada aponta **menos** problemas que a anterior. Pare se a contagem não cair, se
passar de `maxRodadasCorrecao` ou se passar de `maxProblemasPorRodada`.

### 5. Suíte final

Depois do último milestone, um filho roda a suíte completa do que a missão tocou e de quem depende disso: o
`suiteCompleta` da configuração, com `{inicio}` trocado, ou os módulos do `git diff <inicio>..HEAD` e seus
dependentes. Cada falha vira correção, no mesmo loop do passo 4.

Ao fim: story da missão em status 2 e um resumo curto ao usuário: commits, o que foi validado e o que ficou de fora.

## Quedas

Um filho que encerra o turno sem responder, com erro de modelo ou API, ou sem resposta: leia o transcript dele
(`traycer_get_transcript`). Se você despachou e está esperando, arme um `ScheduleWakeup` longo como rede de segurança.

- **Sem rastro no repo:** crie um filho novo com o mesmo briefing.
- **Implementador com diff parcial:** crie outro filho para **continuar** o diff existente. Não descarte o diff.
- **Caiu depois do seu commit:** só adote o commit se o pai for o HEAD esperado e os arquivos forem exatamente os
  da feature revisada. Caso contrário, pare.

Cada queda conta em `maxRetentativasInfra`. Esgotou: pare.

## Paradas e retomada

Pare, sem commitar nada pendente, quando:
- um limite estourar;
- aparecer commit que não é seu;
- o git não bater com o estado;
- surgir desalinhamento de produto.

Ao parar:
1. Atualize `estado/` com o motivo.
2. Deixe o ticket em curso em status 1.
3. Diga ao usuário, em poucas linhas, o que parou e as opções.

Para **retomar**, releia `estado/`. Confira que branch e HEAD batem com o gravado e que a árvore está limpa, salvo o
diff parcial da feature em curso. Continue do ponto gravado. Features já commitadas são reconhecidas pelo título
exato: não renomeie entre execuções. Se o repositório não bater, não adivinhe: mostre a diferença ao usuário.

## Filhos

- Crie com `full_access`, salvo instrução do guia de seleção de agentes do usuário.
- Todo briefing traz:
  - a fronteira: o que pode mudar, o que deve conferir e o que devolve;
  - o aviso de que o filho não fala com o usuário;
  - o pedido para responder a você com `expectReply: true`.
- Filhos não criam outros agentes nem commitam. Isso vale mesmo que o guia de seleção de agentes do usuário mande
  delegar testes a outro agente: o implementador escreve os próprios testes, e o briefing diz isso.

## Escapes Unicode

Ao gravar arquivos, o Write/Edit e o salvamento de artefatos do Traycer trocam a sequência barra invertida + `u` +
4 dígitos hex pelo próprio caractere. Isso estraga regex e strings de código que precisam do escape.

- Em guias e mensagens, descreva o caractere pelo código (`U+2026`) em vez de escrever o escape.
- Avise no briefing o implementador que precisar de escape: grave um marcador e troque via `node`
  (`String.fromCharCode(92)`), ou use `String.fromCharCode(0x2026)` no código.
- Peça que ele confira os bytes do arquivo gravado, e peça o mesmo ao revisor.
