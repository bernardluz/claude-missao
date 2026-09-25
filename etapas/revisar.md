Revise o diff como quem vai assinar o commit.

- Correção primeiro: o diff faz o que a spec pede, nos casos de borda (vazio, nulo, repetido, concorrente, sem permissão)?
- Contrato: quem consome o que mudou continua funcionando?
- Segurança: entrada validada, autorização conferida, segredo fora de log.
- Testes: cobrem o comportamento novo e falhariam sem ele.
- Aponte só o que bloqueia, com arquivo e o porquê. Estilo e preferência não bloqueiam.
