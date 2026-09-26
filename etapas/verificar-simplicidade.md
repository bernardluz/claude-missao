Compare a SPEC com o código atual antes de qualquer plano.

- Para cada tabela, fila, job, estado, tela e endpoint novo, ache o uso real: quem usa e em que clique do fluxo. Sem uso, sugira cortar.
- Procure o que o código já tem e a SPEC recria (entidade, cliente HTTP, componente). Reuso vence peça nova.
- Dado de outro serviço se lê do dono na hora; cópia, projeção ou sincronização só com necessidade medida.
- Estado que se calcula não se grava. Mensageria só para fluxo de fato assíncrono.
- Todo item traz a opção mais simples como sugestão e uma classe:
  - decidido: técnico ou de desenho interno; a missão segue com a sugestão e o usuário revisa no fim;
  - bloqueante: decisão de produto ou de risco (dinheiro, acesso, dado sensível) que nem a SPEC nem o código
    respondem, ou corte de algo que a SPEC pede explicitamente. Só esse para a missão.
- Na dúvida entre as duas, risco decide: item que toca dinheiro, acesso ou autorização, ou dado sensível é bloqueante;
  os demais, com sugestão segura, são decididos.
- Não escreva código nem arquivos.
