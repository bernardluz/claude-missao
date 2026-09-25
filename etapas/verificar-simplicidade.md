Compare a SPEC com o código atual antes de qualquer plano.

- Para cada tabela, fila, job, estado, tela e endpoint novo, ache o uso real: quem usa e em que clique do fluxo. Sem uso, sugira cortar.
- Procure o que o código já tem e a SPEC recria (entidade, cliente HTTP, componente). Reuso vence peça nova.
- Dado de outro serviço se lê do dono na hora; cópia, projeção ou sincronização só com necessidade medida.
- Estado que se calcula não se grava. Mensageria só para fluxo de fato assíncrono.
- Pergunte só o que muda o desenho e o código não responde. Cada pergunta traz a opção mais simples como sugestão.
- Não escreva código nem arquivos.
