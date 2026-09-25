Transforme a SPEC aprovada num plano executável.

- Milestones pequenos (até 8 features), cada um entregável e testável sozinho; o primeiro já exercita o caminho real de ponta a ponta.
- Feature = uma mudança coesa com seus testes, que vira um commit. Título curto e único; spec com o que fazer, onde e como provar.
- Critério do milestone é verificável por teste ou comando, não opinião.
- `caca`: 2 a 4 áreas de risco do milestone (ex.: autorização, concorrência, contrato com outro serviço, migração).
- `userTesting`: só quando há jornada que um usuário percorre (tela, fluxo HTTP de ponta a ponta); descreva os passos e o resultado esperado.
- Siga a ordem de dependência: dados → regras → borda → tela.
