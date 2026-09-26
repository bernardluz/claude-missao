# Registro — Executor da missão no Codex

Data: 2026-09-26. Plano: `docs/codex-executor.plan.md`.
Worktree: `C:/Users/berna/IdeaProjects/claude-missao-codex`.
Branch: `codex/executor-missao`, base `bdde97a`.

## Entrega

- Executor Node para o mesmo workflow JavaScript instalado: injeta args, agent, parallel, phase e log; cada agente chama o Codex CLI.
- Schema estrito/normalização, subprocessos, estado durável, lock por checkout e retomada normal.
- Sandbox explícito, aprovação padrão never, sem bypass e sem usar nomes de modelo Claude.
- Limite de processos, drenagem de irmãos e lock conservado quando há risco de escrita residual.
- Comando npm, README e instrução final das duas skills de preparação adaptados para Codex.

Não foi criada skill de missão. `missao.js`, `instalar.mjs` e `git-estado.mjs` ficaram intactos. Configuração e etapas continuam compartilhadas em .claude. Não há painel nativo do Codex.

## TDD e revisão

- Baseline: 198 testes verdes.
- RED inicial: 14 testes falharam por módulos inexistentes; depois, os mesmos 14 passaram. A mensagem do commit inicial informou 15 por engano; a correção consta no commit seguinte.
- Review de contrato pelo guia TDD exigiu limitar processos, não callbacks de parallel, e drenar chamadas antes de liberar o checkout.
- RED de regressão reproduziu perda de intervenção manual quando uma recusa precedia falha paralela. GREEN após agregar o indicador separadamente.
- RED de regressão reproduziu criação de estado dentro do checkout por junction. GREEN após resolver o ancestral real antes de mkdir.
- Casos adicionais: fila após falha, schema, retomada inválida, CLI, papéis e fluxo completo com commit em Git temporário.
- Review independente final de módulos/testes/integração: nenhum bloqueante novo confirmado. O revisor não concluiu a suíte própria; os resultados completos abaixo foram obtidos pelo coordenador.

## Validação da primeira entrega

- `node --test teste/*.test.mjs`: **221/221 passaram**, sem skip/cancelamento.
- `node --experimental-test-coverage --test-coverage-include="codex/*.mjs" --test teste/codex.test.mjs`: **23/23 passaram**.
- Cobertura agregada: **95,03% linhas, 85,53% branches, 82,26% funções**. Meta de 80% atendida no conjunto, não em cada arquivo (funções de rodar.mjs: 73,91%).
- `node --check` nos três módulos, ajuda CLI e `git diff --check`: passaram.
- Diff dos três arquivos centrais: vazio.
- Integração completa: subprocesso falso na fronteira do modelo, Git temporário real, implementação/revisão simuladas, commit/conferência reais e conclusão. Não é E2E com modelo real.

As primeiras tentativas finais no sandbox receberam avisos de acesso negado do Git e forte lentidão. Foram interrompidas somente as duas árvores de testes identificadas. Com aprovação da ferramenta, a suíte foi repetida fora dessa restrição, sem modelo real ou mudanças de produto.

Evidências locais:
- `%TEMP%/claude-missao-codex-full-approved.log`
- `%TEMP%/claude-missao-codex-coverage-approved.log`
- RED/GREEN: `%TEMP%/claude-missao-codex-red.log` e `%TEMP%/claude-missao-codex-green.log`
- Regressões: arquivos `claude-missao-codex-{red,green}-drain.log` e `claude-missao-codex-{red,green}-junction.log` em %TEMP%.

## Smoke real: limite da evidência

Duas chamadas curtas com o Codex CLI e configuração/modelo do usuário, sem bypass:

1. **JSON sem ferramentas: passou.** Envelope válido e resultado {ok:true}. Prova somente CLI/modelo/schema/transporte.
2. **Leitura de arquivo com ferramentas: não completou.** O arquivo temporário foi lido, mas o provedor/modelo configurado enviou argumentos decimais onde a ferramenta exigia inteiros. Timeout de 120 s encerrou o processo; sem resposta final válida.

Não se mudou modelo/provedor para esconder o problema. Não foi executada nem validada missão real de implementação, revisão e commit.

## Commits por unidade

- e27cd1d: SPEC.
- dae6bd6: plano.
- a5bf471: ajustes do review de contrato.
- a5baa41: RED inicial.
- 936c2d2: regressão de drenagem e testes adicionais.
- 4a17bb8: fluxo completo falso e regressão de junction.
- 9718462: executor.
- 55b69f6: integração nas skills-fonte, comando e documentação.
- Este registro: commit separado por plano.

## Pendências e preservação

- Validar um fluxo real com ferramentas antes de afirmar compatibilidade completa do modelo/provedor atual.
- Depois, integrar a branch e atualizar deliberadamente a instalação global. Não houve merge, push ou instalação global nesta entrega.
- Checkout principal de origem, produto Simpbank e skills globais não foram editados por esta implementação.
- Nenhum serviço, agendamento ou configuração global foi criado.
- Logs podem conter contexto privado; não publicar registros brutos.

Subagentes: guia TDD e revisor independente, autorizados pelo usuário. GitNexus/Cortex não usados. IntelliJ/Dart não se aplicam: alteração somente Node/Markdown, sem Java, Kotlin, Dart ou Flutter.

## Atualização — escolha obrigatória do modelo (2026-09-26)

Pedido do usuário: sempre perguntar qual modelo usar. Antes de iniciar ou retomar no Codex, as duas skills perguntam "Qual modelo você quer usar nesta missão?" e aguardam a resposta. Uma escolha vale para todos os agentes daquela execução. A próxima retomada exige nova escolha, sem herdar modelo do CLI, da conversa ou da execução anterior.

O CLI e as APIs recusam modelo ausente, vazio ou inválido antes de criar registros/lock ou subprocessos; o CLI faz isso antes de ler arquivos de entrada. O modelo escolhido é enviado explicitamente em cada chamada. Falha não autoriza substituição automática.

- Checkpoint RED `284f0c0`: os 5 casos novos falharam pelo motivo esperado, antes da mudança de código.
- Contrato atualizado em `56a44bb`; GREEN/implementação em `5b93efe`.
- Mesmo alvo `node --test --test-name-pattern="modelo escolhido:" teste/codex.test.mjs`: 5/5 GREEN.
- Suíte completa `node --test teste/*.test.mjs`: **226/226 passaram**.
- Cobertura com o comando anterior: **28/28 testes**, **95,78% linhas, 86,19% branches e 84,13% funções** no conjunto do adaptador.
- Revisão independente do delta: sem bloqueantes confirmados; somente leitura estática pelo revisor. Suíte/cobertura executadas pelo coordenador.
- As skills foram instaladas apenas em home temporário de teste; a pergunta, espera pela resposta e comandos com modelo explícito foram conferidos nas duas cópias Codex.

Os testes comprovam o bloqueio sem escolha e a presença das instruções de conversa, não uma interação humana real. Nenhum modelo real foi invocado nesta atualização. Os smokes da primeira entrega acima são anteriores a esta nova regra. Global, main e produto continuam sem alterações por esta adaptação; a validação da missão real continua pendente.

Evidências: `%TEMP%/claude-missao-codex-modelo-red.log`, `claude-missao-codex-modelo-green.log`, `claude-missao-codex-modelo-full.log` e `claude-missao-codex-modelo-coverage.log` na mesma pasta.
