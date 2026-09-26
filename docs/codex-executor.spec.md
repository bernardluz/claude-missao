# SPEC — Executor da missão no Codex

## Entrega
Executar o workflow JavaScript `missao` pelo Codex CLI, mantendo o núcleo compartilhado com o Claude Code. `criar-spec-simples` e `enxugar-codigo` continuam skills de preparação; não criar skill de execução nem um segundo motor de decisão.

## Fluxo
1. O usuário aprova a missão e fornece o projeto e um JSON de argumentos (SPEC ou milestones).
2. O executor verifica projeto, workflow instalado e argumentos locais; cria registros fora do repositório.
3. O JavaScript decide fases, chamadas de agentes, paralelismo, revisão, commits e paradas. Cada chamada usa um processo Codex separado, com resposta estruturada.
4. O resultado e o objeto `retomar` são preservados. Retomada controlada reaproveita esse resultado, e o núcleo confere branch/HEAD antes de continuar.

## Garantias
- Preservar `missao.js`, configurações e testes do Claude; não reimplementar a lógica em prompt.
- CLI sem shell intermediário: prompt por stdin e saída/erros em arquivos, nunca em pipes de build.
- Não herdar permissões irrestritas: sandbox explícito, revisão pura em read-only, demais passos em workspace-write; nunca usar bypass, ignore-rules ou ignore-user-config.
- Aprovação padrão `never` (operações que precisam de aprovação param); auto-review somente por opção explícita do operador, sem full-access.
- Papéis do projeto são lidos de `.codex/agents` ou, por compatibilidade, `.claude/agents`; papel configurado ausente é erro, nunca removido silenciosamente.
- Resultado JSON fora do contrato, recusa, timeout ou falha do CLI param a execução. Não tratar erro como aprovação ou sucesso.
- Registros por execução, sem sobrescrever outra execução; trava por checkout; gravação do resultado antes de declarar conclusão.
- Modelo do CLI configurado pelo usuário, ou opção explícita. Nomes Claude como `haiku` não são enviados como modelos Codex; a diferença fica documentada.

## Limites desta primeira entrega
Não criar painel nativo, serviço em background, agendamento, PR/push, deploy, migração ou missão produtiva. Não instalar global antes da validação. Uma interrupção abrupta conserva logs, mas não autoriza repetir commits nem fabricar um `retomar`; a recuperação exige inspeção. Testes de subprocesso usarão um CLI falso apenas na fronteira do modelo, sem alegar E2E de uma missão real.

## Aceite
- Fluxo instalado executa com adaptador e recebe o resultado real de subprocessos; callbacks `agent`, `parallel`, `phase`, `log` e `args` preservados.
- Testes comprovam permissões, schema/nullable, falhas, concorrência, papel ausente, isolamento dos registros e retomada normal.
- Suíte existente permanece verde. Review independente de contrato e código antes de concluir.
- Smoke opcional do Codex real restrito a leitura e JSON, sem alterações de produto; se ambiente impedir, relatar como não validado.
