# Plano — Executor da missão no Codex

Base: `docs/codex-executor.spec.md`. Branch isolada: `codex/executor-missao`.

## 1. Contrato e RED
- Reaproveitar o executor AsyncFunction já provado pelo simulador, sem alterar o núcleo.
- Guia TDD independente revisa os casos de fronteira.
- Criar testes para schema, transporte do CLI, execução instalada/retomada e permissões. Rodar e registrar RED por ausência do adaptador, não por falha de setup.
- Revisar e commitar o alvo RED isoladamente.

## 2. Adaptador mínimo e GREEN
- `codex/schema.mjs`: converter os schemas usados pelo núcleo para saída estrita, validar e normalizar opcionais nulos.
- `codex/agente.mjs`: subprocessos Codex, papéis, sandbox, saída em arquivo, erros/timeout e paralelismo limitado.
- `codex/rodar.mjs`: entrada CLI, leitura do workflow instalado, estado por execução, trava e resultado/retomar duráveis.
- Tests primeiro por comportamento novo. Rodar os mesmos alvos até GREEN, sem mudar o contrato para acomodar falha.

## 3. Integração de uso
- Acrescentar comando/documentação de execução sem criar skill `missao`.
- Ajustar apenas a instrução de entrega das duas skills para distinguir Claude Code de Codex; não mudar regras de produto.
- Manter arquivos `.claude` compartilhados nesta versão; não duplicar config/workflow em outra árvore.

## 4. Gates e revisão
- Testes focados, suite existente completa e cobertura do novo adaptador (meta 80% por linhas/funções/branches).
- Revisão independente do contrato, depois revisão de código/segurança. Corrigir com teste RED quando comportamento mudar.
- Smoke CLI real somente leitura, quando possível. Não confundir fronteira falsa com modelo real.
- Commits atômicos de testes, implementação e integração; sem push/merge.

## 5. Registro
- `docs/codex-executor.summary.md`: comandos, RED/GREEN, cobertura, reviews, limites e pendências em commit separado por este plano.
- Sem instalar global nem alterar checkout principal antes de validar e explicitar o que já está disponível.
