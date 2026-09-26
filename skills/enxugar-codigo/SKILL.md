---
name: enxugar-codigo
description: "Diagnostica um código já pronto e escreve a SPEC para cortá-lo ao modelo mínimo, antes de rodar a missão no modo enxugar: radiografia medida, uso real, peso x valor, decisões do usuário uma por vez e estratégia de corte. Use quando o usuário pedir para enxugar, simplificar, cortar ou reconstruir um serviço, módulo ou app existente."
---

# Enxugar código

Instalada pelo `claude-missao` no global do Claude e do Codex: edite em `{{CLAUDE_MISSAO}}` e reinstale (veja "Atualizar a missão").

Você conduz, na conversa, o diagnóstico de um alvo que já existe (serviço, módulo, app) e termina numa SPEC. Depois, a
missão roda com `modo: 'enxugar'` e executa. Referência: um serviço financeiro saiu de 23 mil linhas, 34 tabelas e 6
fluxos de mensageria para 3,8 mil linhas, 6 tabelas e nenhuma fila, reconstruído do zero a partir da SPEC.

Siga "Simplicidade primeiro" do projeto: menos tabelas, filas, arquivos e estados vence; dado de outro serviço se lê do
dono na hora; estado derivável é calculado; auditoria é uma tabela de eventos.

## 1. Radiografia do alvo (medida, não estimada)

Meça com comandos reproduzíveis e anote o comando junto do número:
- linhas por pacote ou módulo (código e testes separados);
- tabelas vivas: o que as migrations criam e não removem;
- filas, exchanges, listeners e publishers; jobs e agendamentos;
- estados e máquinas de estado; rotas e endpoints; testes por tipo.

## 2. Uso real

- Quem chama cada rota, fila e evento: busque no repositório inteiro (outros serviços, apps, gates, scripts, docs).
- O que tem dado em produção, quando o usuário puder informar ou houver acesso de leitura autorizado.
- Código morto: sem chamador, sem rota exposta, sem teste que o exercite por um fluxo real.

## 3. Peso x valor

Mostre onde está o volume e qual decisão de desenho o causa. Padrões comuns:
- cópia ou projeção de dados de outro serviço, com sincronização;
- mensageria onde HTTP síncrono bastava, com inbox, outbox, retentativa e quarentena;
- auditoria ou histórico em paralelo à tabela de eventos;
- multiempresa, versões de regra ou configurabilidade sem cliente real.

## 4. Modelo mínimo e decisões

Proponha o modelo alvo em poucas linhas (tabelas, rotas, fluxos) e pergunte ao usuário o que só ele decide, **uma
pergunta por vez**, sempre com a opção mais simples como sugestão: quem usa de fato, o que pode sair, o que outro
serviço já faz, se há dado real a preservar.

## 5. Saída: a SPEC

No formato da skill `criar-spec-simples`, com a primeira linha `<!-- modo: enxugar -->` (a missão reconhece o modo por
ela) e estas seções a mais:

```markdown
<!-- modo: enxugar -->
# Enxugar <alvo>

## Estado atual (medido)
| Medida | Valor | Comando |
|---|---|---|
| Linhas de código | … | … |
| Tabelas vivas | … | … |
| Filas / listeners | … | … |
| Arquivos | … | … |
| Testes | … | … |

## Modelo alvo
Tabelas, rotas e fluxos que ficam, cada um com o uso real (passo do fluxo em cliques).

## O que sai
Cada peça que sai e por quê (sem uso, duplicada, substituída por leitura no dono…).

## Consumidores que mudam junto
Outros serviços, apps, gates, scripts e docs que usam o que sai ou muda, com arquivo.

## Estratégia de corte
- Reconstruir do zero ou cirurgia no código atual, e por quê.
- Hardcut (sem dado real) ou migration de avanço (com dado real a preservar).
- Ordem de deploy entre o alvo e os consumidores.

## Critérios de aceite
Verificáveis por teste ou comando, incluindo a medição final.

## Antes x depois (a missão preenche)
| Medida | Antes | Depois |
|---|---|---|
| Linhas de código | | |
| Tabelas vivas | | |
| Filas / listeners | | |
| Arquivos | | |
| Testes | | |
```

Mostre a SPEC ao usuário. Aprovada, grave-a no projeto e rode o workflow `missao` com `{ "spec": "<caminho>", "modo":
"enxugar" }`. O resultado traz `medicao` com o antes e o depois para preencher a última tabela.
