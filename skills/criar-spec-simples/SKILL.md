---
name: criar-spec-simples
description: "Escreve a SPEC de uma entrega no modelo de simplicidade, antes de rodar a missão: quem usa, fluxo em cliques, cada tabela, fila, job e estado com uso real, cortes explícitos, cabendo numa página. Use quando o usuário pedir para escrever, revisar ou enxugar uma SPEC, ou antes de passar `spec` ao workflow missao."
---

# SPEC simples

Instalada pelo `claude-missao` no global do Claude e do Codex: edite em `{{CLAUDE_MISSAO}}` e reinstale (veja "Atualizar a missão").

Você escreve a SPEC na conversa, com o usuário, antes da missão. A missão depois confere a simplicidade, gera o plano e
executa. Uma SPEC boa cabe numa página e deixa claro o que **não** entra.

## Antes de escrever

1. Leia o código da área: o que já existe e pode ser reusado (entidade, endpoint, cliente, tela).
2. Descubra quem é o dono de cada dado. Dado de outro serviço se lê do dono na hora; não se copia.
3. Pergunte ao usuário só o que muda o desenho e o código não responde, uma pergunta por vez, sempre com a opção mais
   simples como sugestão.

## Estrutura

```markdown
# <Nome da entrega>

## Quem usa e para quê
Uma ou duas frases: quem, qual problema, qual resultado.

## Fluxo em cliques
1. O usuário abre X e vê Y.
2. Clica em Z; o sistema faz W e mostra V.
(Cada passo é algo que alguém faz ou vê. Se um passo não aparece para ninguém, questione se ele precisa existir.)

## O que muda
| Peça | Tipo | Uso real (passo do fluxo) |
|---|---|---|
| tabela `pedido` | tabela | passos 2 e 3 |
| `POST /pedidos` | endpoint | passo 2 |

## Fora do escopo
- O que parece necessário mas não entra agora, e por quê.

## Critérios de aceite
- Verificáveis por teste ou comando: "POST /pedidos sem permissão devolve 403", não "funciona bem".
```

## Regras de corte

- Cada tabela, fila, job, estado, coluna e tela precisa apontar para um passo do fluxo. Sem uso real, sai.
- Estado que se calcula a partir de outros dados não se grava.
- Mensageria só para fluxo de fato assíncrono; consulta que a tela espera é chamada síncrona.
- Auditoria, histórico, versionamento e recuperação só quando o risco pede (dinheiro saindo pede mais; organização
  interna pede menos).
- Entre duas soluções corretas, vence a que tem menos peças.
- Passou de uma página: divida a entrega ou corte.

## Depois

Aprovada a SPEC, grave-a num arquivo do projeto. A execução continua sendo um workflow, não uma skill.

**No Codex, antes de iniciar ou retomar**, pergunte: **"Qual modelo você quer usar nesta missão?"**
Aguarde a resposta do usuário. Sem resposta explícita, não inicie a missão. Não use automaticamente o modelo do CLI, da conversa ou da execução anterior.
A escolha vale para todos os agentes dessa execução; não pergunte por subagente. Se o modelo escolhido falhar, pare sem substituir por outro.

- **Claude Code:** rode o workflow `missao` com `spec` apontando para o arquivo (e `aceite`, se estiver em outro lugar).
- **Codex:** grave os argumentos em JSON e use `node "{{CLAUDE_MISSAO}}/codex/rodar.mjs" --projeto "<raiz>" --args "<argumentos.json>" --modelo "<modelo-escolhido>"`.

O projeto precisa da missão instalada por `instalar.mjs <projeto>`. No Codex, a aprovação padrão é `never`: se uma operação exigir permissão, a missão para. `--aprovacao auto` só entra com autorização explícita do usuário para revisão automática de permissões. Não usar bypass nem substituir uma execução indisponível por simulação. Para retomar uma parada normal, usar `--retomar "<resultado.json>" --modelo "<modelo-escolhido>"` no lugar de `--args`.
